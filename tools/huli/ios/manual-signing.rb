# Points each app/extension target's Release build at its App Store profile, signed by hand.
# Usage: ruby manual-signing.rb <project.xcodeproj> <signing.json>
require 'json'
require 'xcodeproj'

project = Xcodeproj::Project.open(ARGV[0])
signing = JSON.parse(File.read(ARGV[1]))
project.targets.each do |target|
  next unless %i[application app_extension].include?(target.symbol_type)
  target.build_configurations.each do |config|
    next unless config.name == 'Release'
    id = config.build_settings['PRODUCT_BUNDLE_IDENTIFIER']
    profile = signing['profiles'][id]
    abort "no profile for #{id} (target #{target.name})" unless profile
    s = config.build_settings
    s['CODE_SIGN_STYLE'] = 'Manual'
    s['DEVELOPMENT_TEAM'] = 'Z5C6TTY2YF'
    identity = signing['signing'] || 'Apple Distribution'
    s['CODE_SIGN_IDENTITY'] = identity
    s['CODE_SIGN_IDENTITY[sdk=iphoneos*]'] = identity
    s['PROVISIONING_PROFILE_SPECIFIER'] = profile['name']
    puts "#{target.name}: #{id} -> #{profile['name']}"
  end
end
project.save
