// Opens what the user picked in Spotlight (an indexed session) or continued from another device or
// a Siri suggestion (the open session's activity): the scene delegate forwards both here, and the
// session's link waits for JavaScript like an intent's (PendingLink).

import CoreSpotlight
import ExpoModulesCore
import UIKit

public class HuliSystemAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    guard let url = HuliSystemAppDelegate.link(for: userActivity) else { return false }
    PendingLink.put(url)
    restorationHandler(nil)
    return true
  }

  static func link(for activity: NSUserActivity) -> URL? {
    if activity.activityType == CSSearchableItemActionType {
      guard let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String
      else { return nil }
      return SessionIndex.link(identifier)
    }
    if activity.activityType == SessionActivity.type,
      let text = activity.userInfo?["url"] as? String,
      let url = URL(string: text),
      url.scheme == "huli"
    {
      return url
    }
    return nil
  }
}
