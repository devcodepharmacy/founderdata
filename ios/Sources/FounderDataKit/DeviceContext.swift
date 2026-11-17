import Foundation

enum DeviceContext {
    static func current(bundle: Bundle = .main) -> WireContext {
        let info = bundle.infoDictionary ?? [:]
        return WireContext(
            appVersion: info["CFBundleShortVersionString"] as? String ?? "0",
            build: info["CFBundleVersion"] as? String ?? "0",
            osVersion: osVersion(),
            device: deviceModel(),
            locale: localeIdentifier(),
            bundleId: bundle.bundleIdentifier ?? "unknown"
        )
    }

    /// "26.1" or "26.1.2".
    static func osVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return v.patchVersion == 0
            ? "\(v.majorVersion).\(v.minorVersion)"
            : "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    /// Hardware model such as "iPhone17,1". The server maps an "iPad" prefix to Tablet.
    static func deviceModel() -> String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty {
            return simulated
        }
        var system = utsname()
        uname(&system)
        let model = withUnsafeBytes(of: system.machine) { buffer in
            String(decoding: buffer.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        return model.isEmpty ? "unknown" : model
    }

    /// "en_US", without "@rg=..." region overrides.
    static func localeIdentifier() -> String {
        let id = Locale.current.identifier
        return id.split(separator: "@").first.map(String.init) ?? id
    }
}
