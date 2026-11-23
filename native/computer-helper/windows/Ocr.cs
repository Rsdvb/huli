// Text recognition with the OCR engine Windows ships (Windows.Media.Ocr): the lines in a
// screenshot with their boxes in the screenshot's own pixels, so an agent can click by pixel.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace Kite.ComputerHelper
{
    static class Ocr
    {
        const int MaxImageBytes = 48 * 1024 * 1024;
        const int MaxLines = 400;

        public static object Recognize(Dictionary<string, object> request)
        {
            string data = Json.Text(request, "image");
            byte[] bytes = Convert.FromBase64String(data);
            if (bytes.Length == 0 || bytes.Length > MaxImageBytes) throw new ArgumentException("The image is empty or too large.");
            List<OcrEngine> engines = Engines(Json.OptionalText(request, "language"));
            if (engines.Count == 0) throw new InvalidOperationException("Windows has no text recognition for the user's languages.");

            SoftwareBitmap bitmap = Decode(bytes);
            int width = bitmap.PixelWidth;
            int height = bitmap.PixelHeight;
            double scale = 1;
            uint max = OcrEngine.MaxImageDimension;
            if (width > max || height > max)
            {
                // Too large for the engine: read a smaller copy and scale the boxes back.
                scale = Math.Min((double)max / width, (double)max / height);
                bitmap.Dispose();
                bitmap = Decode(bytes, (uint)(width * scale), (uint)(height * scale));
            }
            List<Line> found;
            using (bitmap)
            {
                var read = engines.Select(engine => Lines(Await(engine.RecognizeAsync(bitmap)), scale).ToList()).ToList();
                found = read.Count == 1 ? read[0] : Merge(read[0], read[1]);
            }
            found.Sort((a, b) => a.Y != b.Y ? a.Y.CompareTo(b.Y) : a.X.CompareTo(b.X));
            var lines = new List<object>();
            foreach (Line line in found.Take(MaxLines))
            {
                lines.Add(new Dictionary<string, object>
                {
                    { "text", line.Text },
                    { "x", Round(line.X) },
                    { "y", Round(line.Y) },
                    { "width", Round(line.Width) },
                    { "height", Round(line.Height) },
                });
            }
            return new Dictionary<string, object>
            {
                { "languages", engines.Select(e => e.RecognizerLanguage.LanguageTag).ToArray() },
                { "width", width },
                { "height", height },
                { "lines", lines },
            };
        }

        sealed class Line
        {
            public string Text;
            public double X, Y, Width, Height;
        }

        static IEnumerable<Line> Lines(OcrResult result, double scale)
        {
            foreach (OcrLine line in result.Lines)
            {
                var words = line.Words.ToList();
                if (words.Count == 0) continue;
                double left = double.MaxValue, top = double.MaxValue, right = 0, bottom = 0;
                foreach (OcrWord word in words)
                {
                    left = Math.Min(left, word.BoundingRect.X);
                    top = Math.Min(top, word.BoundingRect.Y);
                    right = Math.Max(right, word.BoundingRect.X + word.BoundingRect.Width);
                    bottom = Math.Max(bottom, word.BoundingRect.Y + word.BoundingRect.Height);
                }
                yield return new Line
                {
                    Text = Join(words),
                    X = left / scale,
                    Y = top / scale,
                    Width = (right - left) / scale,
                    Height = (bottom - top) / scale,
                };
            }
        }

        /// <summary>
        /// The lines of the engine for Chinese, Japanese or Korean and of the one for other scripts
        /// as one list, as each misreads the other's text: where both found a line, the other
        /// engine's wins when it reads as words, and the wide engine's when its text is mostly wide.
        /// </summary>
        static List<Line> Merge(List<Line> wide, List<Line> other)
        {
            var kept = new List<Line>();
            var dropped = new HashSet<Line>();
            foreach (Line line in wide)
            {
                var overlapping = other.Where(o => Overlap(line, o)).ToList();
                if (overlapping.Count == 0)
                {
                    // Found by this engine alone: kept when it reads as wide text or as words.
                    if (WideShare(line.Text) >= 0.5 || WordShare(line.Text) >= 0.5) kept.Add(line);
                    continue;
                }
                if (WideShare(line.Text) < 0.5 || overlapping.Any(o => WordShare(o.Text) >= 0.75)) continue;
                kept.Add(line);
                foreach (Line o in overlapping) dropped.Add(o);
            }
            foreach (Line line in other)
            {
                if (!dropped.Contains(line) && !kept.Any(k => Overlap(line, k))) kept.Add(line);
            }
            return kept;
        }

        static readonly Regex Word = new Regex(@"^([A-Za-z][a-z'-]*|[A-Z'-]+)$");
        static readonly Regex Number = new Regex(@"^[0-9.,:/%+-]+$");
        static readonly Regex Strokes = new Regex("^[iIlLjJtf1|]+$");

        /// <summary>The share of a text's tokens that read as words or numbers of a Latin script.</summary>
        static double WordShare(string text)
        {
            int good = 0, total = 0;
            foreach (string raw in text.Split(' '))
            {
                string token = raw.Trim(".,:;!?()[]\"'-".ToCharArray());
                if (token.Length == 0) continue;
                total++;
                if (Number.IsMatch(token)) good++;
                else if (Word.IsMatch(token) && (token.Length <= 2 || (token.IndexOfAny("aeiouyAEIOUY".ToCharArray()) >= 0 && !Strokes.IsMatch(token)))) good++;
            }
            return total == 0 ? 0 : (double)good / total;
        }

        static bool Overlap(Line a, Line b)
        {
            double w = Math.Min(a.X + a.Width, b.X + b.Width) - Math.Max(a.X, b.X);
            double h = Math.Min(a.Y + a.Height, b.Y + b.Height) - Math.Max(a.Y, b.Y);
            if (w <= 0 || h <= 0) return false;
            double smaller = Math.Min(a.Width * a.Height, b.Width * b.Height);
            return smaller > 0 && w * h / smaller > 0.3;
        }

        /// <summary>
        /// The engines to read with: the one asked for; else the user's first language's, and the
        /// first installed one of the other script family (Chinese, Japanese and Korean, or not).
        /// </summary>
        static List<OcrEngine> Engines(string language)
        {
            var engines = new List<OcrEngine>();
            if (!string.IsNullOrEmpty(language))
            {
                var wanted = new Language(language);
                if (OcrEngine.IsLanguageSupported(wanted))
                {
                    engines.Add(OcrEngine.TryCreateFromLanguage(wanted));
                    return engines;
                }
            }
            OcrEngine primary = OcrEngine.TryCreateFromUserProfileLanguages();
            var available = OcrEngine.AvailableRecognizerLanguages.ToList();
            if (primary == null && available.Count > 0) primary = OcrEngine.TryCreateFromLanguage(available[0]);
            if (primary == null) return engines;
            engines.Add(primary);
            bool wide = WideLanguage(primary.RecognizerLanguage.LanguageTag);
            Language other = available.FirstOrDefault(l => WideLanguage(l.LanguageTag) != wide);
            if (other != null)
            {
                OcrEngine second = OcrEngine.TryCreateFromLanguage(other);
                // The wide engine reads first, so its lines win where both found one.
                if (second != null) engines.Insert(wide ? 1 : 0, second);
            }
            return engines;
        }

        static bool WideLanguage(string tag)
        {
            string lower = tag.ToLowerInvariant();
            return lower.StartsWith("zh") || lower.StartsWith("ja") || lower.StartsWith("ko");
        }

        /// <summary>The share of a text's letters that are Chinese, Japanese or Korean.</summary>
        static double WideShare(string text)
        {
            int letters = 0, wide = 0;
            foreach (char c in text)
            {
                if (!char.IsLetterOrDigit(c)) continue;
                letters++;
                if (Wide(c)) wide++;
            }
            return letters == 0 ? 0 : (double)wide / letters;
        }

        static SoftwareBitmap Decode(byte[] bytes, uint width = 0, uint height = 0)
        {
            using (var stream = new InMemoryRandomAccessStream())
            {
                using (var writer = new DataWriter(stream))
                {
                    writer.WriteBytes(bytes);
                    Await(writer.StoreAsync());
                    writer.DetachStream();
                }
                stream.Seek(0);
                BitmapDecoder decoder = Await(BitmapDecoder.CreateAsync(stream));
                SoftwareBitmap bitmap;
                if (width > 0 && height > 0)
                {
                    var transform = new BitmapTransform
                    {
                        ScaledWidth = width,
                        ScaledHeight = height,
                        InterpolationMode = BitmapInterpolationMode.Fant,
                    };
                    bitmap = Await(decoder.GetSoftwareBitmapAsync(
                        BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, transform,
                        ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage));
                }
                else
                {
                    bitmap = Await(decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied));
                }
                return bitmap;
            }
        }

        /// <summary>
        /// A line's words as one string. The engine gives each Chinese, Japanese or Korean character
        /// as a word of its own, which read with no space between them.
        /// </summary>
        static string Join(List<OcrWord> words)
        {
            var text = new System.Text.StringBuilder();
            string previous = null;
            foreach (OcrWord word in words)
            {
                string current = word.Text;
                if (previous != null && !(Wide(previous[previous.Length - 1]) && Wide(current[0]))) text.Append(' ');
                text.Append(current);
                previous = current;
            }
            return text.ToString();
        }

        static bool Wide(char c)
        {
            UnicodeCategory category = char.GetUnicodeCategory(c);
            return (c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0xF900 && c <= 0xFAFF) ||
                (c >= 0xFF00 && c <= 0xFFEF) || category == UnicodeCategory.OtherLetter && c > 0x3000;
        }

        /// <summary>
        /// The result of a Windows Runtime operation, waited for without the .NET projection's
        /// helpers, whose assembly expects the SDK's single Windows.winmd.
        /// </summary>
        static T Await<T>(IAsyncOperation<T> operation)
        {
            using (var done = new ManualResetEventSlim())
            {
                operation.Completed = delegate { done.Set(); };
                if (!done.Wait(TimeSpan.FromSeconds(60))) throw new TimeoutException("Text recognition took too long.");
            }
            if (operation.Status == AsyncStatus.Error) throw new InvalidOperationException("Text recognition failed: " + operation.ErrorCode.Message);
            if (operation.Status != AsyncStatus.Completed) throw new InvalidOperationException("Text recognition was cancelled.");
            return operation.GetResults();
        }

        static double Round(double value)
        {
            return Math.Round(value, 1);
        }
    }
}
