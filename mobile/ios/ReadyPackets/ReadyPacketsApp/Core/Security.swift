import Foundation
import Security
import LocalAuthentication

actor TokenStore {
    private let service = "com.readypackets.mobile"
    private let refreshAccount = "refresh-token"
    private let authorizationStateAccount = "oauth-state"
    private let authorizationVerifierAccount = "oauth-pkce-verifier"
    private let authorizationStartedAtAccount = "oauth-started-at"
    private(set) var accessToken: String?
    private(set) var accessTokenExpiry: Date?

    var refreshToken: String? { readKeychain(account: refreshAccount) }
    var authorizationState: String? { readKeychain(account: authorizationStateAccount) }
    var authorizationVerifier: String? { readKeychain(account: authorizationVerifierAccount) }

    func save(tokens: TokenSet) throws {
        try writeKeychain(tokens.refreshToken, account: refreshAccount)
        accessToken = tokens.accessToken
        accessTokenExpiry = Date().addingTimeInterval(TimeInterval(max(tokens.expiresIn - 30, 30)))
    }

    func saveAuthorizationAttempt(state: String, verifier: String) throws {
        try writeKeychain(state, account: authorizationStateAccount)
        try writeKeychain(verifier, account: authorizationVerifierAccount)
        try writeKeychain(String(Date().timeIntervalSince1970), account: authorizationStartedAtAccount)
    }

    func validAuthorizationAttempt(maxAge: TimeInterval = 600) -> (state: String, verifier: String)? {
        guard let state = authorizationState,
              let verifier = authorizationVerifier,
              let started = readKeychain(account: authorizationStartedAtAccount).flatMap(TimeInterval.init),
              Date().timeIntervalSince1970 - started <= maxAge else {
            clearAuthorizationAttempt()
            return nil
        }
        return (state, verifier)
    }

    func clearAuthorizationAttempt() {
        deleteKeychain(account: authorizationStateAccount)
        deleteKeychain(account: authorizationVerifierAccount)
        deleteKeychain(account: authorizationStartedAtAccount)
    }

    func wipe() {
        accessToken = nil
        accessTokenExpiry = nil
        deleteKeychain(account: refreshAccount)
        clearAuthorizationAttempt()
    }

    private func readKeychain(account: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func writeKeychain(_ value: String, account: String) throws {
        deleteKeychain(account: account)
        let values: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecValueData: Data(value.utf8),
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        guard SecItemAdd(values as CFDictionary, nil) == errSecSuccess else {
            throw CocoaError(.fileWriteNoPermission)
        }
    }

    private func deleteKeychain(account: String) {
        SecItemDelete([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ] as CFDictionary)
    }
}

enum BiometricGate {
    static func authenticate() async throws {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            throw error ?? LAError(.biometryNotAvailable)
        }
        try await context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            localizedReason: "Unlock your ReadyPackets session",
        )
    }
}
