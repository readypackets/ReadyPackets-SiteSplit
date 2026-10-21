import Foundation
import UIKit
import AuthenticationServices
import CryptoKit
import Security

@MainActor
final class AuthCoordinator {
    private let api: MobileAPIClient
    private let tokenStore: TokenStore
    private var state: String?
    private var verifier: String?
    private let installationID: String
    private var webAuthenticationSession: ASWebAuthenticationSession?
    private let presentationContext = AuthenticationPresentationContext()
    var onAuthorizationResult: ((Result<Void, Error>) -> Void)?

    init(api: MobileAPIClient, tokenStore: TokenStore) {
        self.api = api
        self.tokenStore = tokenStore
        installationID = UserDefaults.standard.string(forKey: "rp.installation.id")
            ?? UUID().uuidString.lowercased().also {
                UserDefaults.standard.set($0, forKey: "rp.installation.id")
            }
    }

    func begin() async throws {
        let newState = try Self.randomURLSafeString(byteCount: 32)
        let newVerifier = try Self.randomURLSafeString(byteCount: 64)
        try await tokenStore.saveAuthorizationAttempt(state: newState, verifier: newVerifier)
        state = newState
        verifier = newVerifier
        let challenge = Data(SHA256.hash(data: Data(newVerifier.utf8))).base64URLEncodedString()
        var components = URLComponents(
            url: AppConfig.portalBaseURL.appending(path: "/api/mobile/v1/authorize"),
            resolvingAgainstBaseURL: false,
        )!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: "readypackets-native"),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "redirect_uri", value: AppConfig.redirectURI.absoluteString),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: newState),
            URLQueryItem(name: "device_id", value: installationID),
            URLQueryItem(name: "platform", value: "ios"),
            URLQueryItem(name: "app_version", value: AppConfig.appVersion),
            URLQueryItem(name: "scope", value: "mobile:read mobile:write"),
        ]
        guard let url = components.url else { throw URLError(.badURL) }
        let session = ASWebAuthenticationSession(
            url: url,
            callbackURLScheme: AppConfig.redirectURI.scheme,
        ) { [weak self] callback, sessionError in
            Task { @MainActor [weak self] in
                await self?.handleBrowserCallback(callback, sessionError: sessionError)
            }
        }
        session.presentationContextProvider = presentationContext
        session.prefersEphemeralWebBrowserSession = false
        webAuthenticationSession = session
        guard session.start() else {
            await tokenStore.clearAuthorizationAttempt()
            throw APIProblem(
                title: "Secure sign-in unavailable",
                code: "browser_session_failed",
                detail: "The system browser could not start the sign-in session.",
            )
        }
    }

    func complete(with url: URL) async throws {
        guard url.scheme == AppConfig.redirectURI.scheme,
              url.host == AppConfig.redirectURI.host,
              url.path == AppConfig.redirectURI.path else {
            throw APIProblem(
                title: "Unrecognized sign-in return",
                code: "redirect_mismatch",
                detail: "The sign-in callback did not match this application.",
            )
        }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let returnedState = components?.queryItems?.first(where: { $0.name == "state" })?.value
        let attempt = await tokenStore.validAuthorizationAttempt()
        let expectedState = state ?? attempt?.state
        let expectedVerifier = verifier ?? attempt?.verifier
        guard returnedState == expectedState,
              let code = components?.queryItems?.first(where: { $0.name == "code" })?.value,
              let expectedVerifier else {
            await tokenStore.clearAuthorizationAttempt()
            throw APIProblem(
                title: "Sign-in could not be verified",
                code: "state_mismatch",
                detail: "Please begin sign-in again.",
            )
        }
        let tokens = try await api.tokenRequest(form: [
            "grant_type": "authorization_code",
            "client_id": "readypackets-native",
            "code": code,
            "code_verifier": expectedVerifier,
            "redirect_uri": AppConfig.redirectURI.absoluteString,
        ])
        try await tokenStore.save(tokens: tokens)
        await tokenStore.clearAuthorizationAttempt()
        state = nil
        verifier = nil
        webAuthenticationSession = nil
    }

    private func handleBrowserCallback(_ callback: URL?, sessionError: Error?) async {
        defer { webAuthenticationSession = nil }
        guard let callback else {
            await clearPendingAuthorizationAttempt()
            onAuthorizationResult?(.failure(sessionError ?? APIProblem(
                title: "Sign-in did not complete",
                code: "browser_session_cancelled",
                detail: "Please begin sign-in again when you are ready.",
            )))
            return
        }
        do {
            try await complete(with: callback)
            onAuthorizationResult?(.success(()))
        } catch {
            await clearPendingAuthorizationAttempt()
            onAuthorizationResult?(.failure(error))
        }
    }

    private func clearPendingAuthorizationAttempt() async {
        await tokenStore.clearAuthorizationAttempt()
        state = nil
        verifier = nil
    }

    private static func randomURLSafeString(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw APIProblem(
                title: "Secure sign-in unavailable",
                code: "randomness_unavailable",
                detail: "Your device could not prepare a secure authorization request.",
            )
        }
        return Data(bytes).base64URLEncodedString()
    }
}

private final class AuthenticationPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first?.keyWindow ?? ASPresentationAnchor()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private extension String {
    func also(_ body: (String) -> Void) -> String { body(self); return self }
}
