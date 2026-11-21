// Huli's Android share sheet for a file the phone downloaded from a computer, which React Native's
// Share cannot offer there: it shares text alone. The file goes by the content URI expo-file-system's
// provider serves it under (File.contentUri), readable by the app the user picks.

package io.github.rsdvb.huli.system

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HuliShareModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HuliShare")

    AsyncFunction("share") { contentUri: String, mimeType: String, title: String ->
      val uri = Uri.parse(contentUri)
      if (uri.scheme != "content") {
        throw CodedException("ERR_HULI_SHARE_URI", "Only a content URI can be shared", null)
      }
      val send = Intent(Intent.ACTION_SEND).apply {
        type = mimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TITLE, title)
        clipData = ClipData.newRawUri(title, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, title).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      appContext.throwingActivity.startActivity(chooser)
    }
  }
}
