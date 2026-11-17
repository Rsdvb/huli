Pod::Spec.new do |s|
  s.name           = 'HuliSystem'
  s.version        = '1.0.0'
  s.summary        = "Huli's Spotlight index, current activity and the links Siri and Spotlight open"
  s.description    = s.summary
  s.license        = 'AGPL-3.0-only'
  s.author         = 'Huli'
  s.homepage       = 'https://github.com/rsdvb/huli'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreSpotlight', 'UniformTypeIdentifiers'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
end
