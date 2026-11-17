#if canImport(SwiftUI)
import SwiftUI

extension View {
    /// Records `FounderData.screen(name)` each time this view appears.
    public func founderDataScreen(_ name: String) -> some View {
        modifier(FounderDataScreenModifier(name: name))
    }
}

private struct FounderDataScreenModifier: ViewModifier {
    let name: String

    func body(content: Content) -> some View {
        content.onAppear { FounderData.screen(name) }
    }
}
#endif
