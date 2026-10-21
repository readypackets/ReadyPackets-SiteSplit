import SwiftUI

@main
struct ReadyPacketsApp: App {
    @StateObject private var container = AppContainer()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(container)
                .tint(Brand.teal)
                .onOpenURL { url in
                    Task { await container.handleCallback(url) }
                }
                .task { await container.restore() }
        }
    }
}

@MainActor
final class AppContainer: ObservableObject {
    enum State { case loading, signedOut, locked, signedIn }
    @Published private(set) var state: State = .loading
    @Published var toast: String?
    let tokenStore = TokenStore()
    lazy var api = MobileAPIClient(tokenStore: tokenStore)
    lazy var auth: AuthCoordinator = {
        let coordinator = AuthCoordinator(api: api, tokenStore: tokenStore)
        coordinator.onAuthorizationResult = { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                state = .signedIn
            case .failure(let error):
                state = .signedOut
                toast = error.localizedDescription
            }
        }
        return coordinator
    }()

    func restore() async {
        guard await tokenStore.refreshToken != nil else { state = .signedOut; return }
        state = .locked
    }

    func signIn() async {
        do { try await auth.begin(); toast = "Continue securely in your browser." }
        catch { toast = error.localizedDescription }
    }

    func unlock() async {
        do { try await BiometricGate.authenticate(); state = .signedIn }
        catch { toast = error.localizedDescription }
    }

    func handleCallback(_ url: URL) async {
        do { try await auth.complete(with: url); state = .signedIn }
        catch { state = .signedOut; toast = error.localizedDescription }
    }

    func signOut() async {
        await api.revoke()
        await tokenStore.wipe()
        state = .signedOut
    }
}
