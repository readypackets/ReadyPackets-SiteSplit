import Foundation

actor MobileAPIClient {
    private let tokenStore: TokenStore
    private let session: URLSession
    private let decoder: JSONDecoder

    init(tokenStore: TokenStore, session: URLSession = .shared) {
        self.tokenStore = tokenStore
        self.session = session
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func tokenRequest(form: [String: String]) async throws -> TokenSet {
        var request = URLRequest(url: AppConfig.portalBaseURL.appending(path: "/api/mobile/v1/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = form.map { "\($0.key.urlEncoded)=\($0.value.urlEncoded)" }.sorted().joined(separator: "&").data(using: .utf8)
        let (data, response) = try await session.data(for: request)
        return try decode(TokenSet.self, data: data, response: response)
    }

    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        try await request(path: path, method: "GET", body: nil, idempotencyKey: nil, as: type)
    }

    func post<T: Decodable>(_ path: String, body: Encodable, idempotencyKey: UUID = UUID(), as type: T.Type) async throws -> T {
        try await request(path: path, method: "POST", body: body, idempotencyKey: idempotencyKey.uuidString, as: type)
    }

    func revoke() async {
        guard let refresh = await tokenStore.refreshToken else { return }
        var request = URLRequest(url: AppConfig.portalBaseURL.appending(path: "/api/mobile/v1/revoke"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = "token=\(refresh.urlEncoded)&client_id=readypackets-native".data(using: .utf8)
        _ = try? await session.data(for: request)
    }

    private func request<T: Decodable>(path: String, method: String, body: Encodable?, idempotencyKey: String?, as type: T.Type, attemptedRefresh: Bool = false) async throws -> T {
        let access = try await validAccessToken()
        var urlRequest = URLRequest(url: AppConfig.portalBaseURL.appending(path: "/api/mobile/v1" + path))
        urlRequest.httpMethod = method
        urlRequest.setValue("Bearer \(access)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if let idempotencyKey { urlRequest.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        if let body { urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type"); urlRequest.httpBody = try JSONEncoder().encode(AnyEncodable(body)) }
        let (data, response) = try await session.data(for: urlRequest)
        if let http = response as? HTTPURLResponse, http.statusCode == 401, !attemptedRefresh {
            _ = try await refresh()
            return try await request(path: path, method: method, body: body, idempotencyKey: idempotencyKey, as: type, attemptedRefresh: true)
        }
        return try decode(T.self, data: data, response: response)
    }

    private func validAccessToken() async throws -> String {
        if let token = await tokenStore.accessToken, let expiry = await tokenStore.accessTokenExpiry, expiry > Date() { return token }
        return try await refresh().accessToken
    }

    private func refresh() async throws -> TokenSet {
        guard let refreshToken = await tokenStore.refreshToken else { throw APIProblem(title: "Sign in required", code: "signed_out", detail: "Please sign in again.") }
        let tokens = try await tokenRequest(form: ["grant_type": "refresh_token", "client_id": "readypackets-native", "refresh_token": refreshToken])
        try await tokenStore.save(tokens: tokens)
        return tokens
    }

    private func decode<T: Decodable>(_ type: T.Type, data: Data, response: URLResponse) throws -> T {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200...299).contains(http.statusCode) else { throw (try? decoder.decode(APIProblem.self, from: data)) ?? APIProblem(title: "Request failed", code: "http_\(http.statusCode)", detail: nil) }
        return try decoder.decode(T.self, from: data)
    }
}

private struct AnyEncodable: Encodable { let value: Encodable; init(_ value: Encodable) { self.value = value }; func encode(to encoder: Encoder) throws { try value.encode(to: encoder) } }
private extension String { var urlEncoded: String { addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? self } }
