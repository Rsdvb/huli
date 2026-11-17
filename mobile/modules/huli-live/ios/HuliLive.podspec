Pod::Spec.new do |s|
  s.name           = 'HuliLive'
  s.version        = '1.0.0'
  s.summary        = "Huli's Live Activities and home-screen widget data"
  s.description    = s.summary
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Huli'
  s.homepage       = 'https://github.com/rsdvb/huli'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ActivityKit', 'WidgetKit'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
end
