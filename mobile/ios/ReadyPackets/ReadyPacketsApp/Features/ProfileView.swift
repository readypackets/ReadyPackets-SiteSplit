import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var profile: Profile?
    @State private var devices: [DeviceRecord] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let profile {
                    Section("Account") {
                        LabeledContent("Name", value: profile.displayName)
                        LabeledContent("Email", value: profile.email)
                        LabeledContent("Role", value: profile.role.capitalized)
                        Label(
                            profile.mfaEnabled ? "Two-factor authentication enabled" : "Two-factor authentication needs attention",
                            systemImage: profile.mfaEnabled ? "checkmark.shield" : "exclamationmark.shield"
                        )
                        .foregroundStyle(profile.mfaEnabled ? Brand.teal : Brand.gold)
                    }
                }

                Section("Your devices") {
                    ForEach(devices) { device in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(device.deviceName ?? "\(device.platform.capitalized) device")
                                if device.current {
                                    Text("This device")
                                        .font(.caption)
                                        .foregroundStyle(Brand.teal)
                                }
                            }
                            Text("\(device.platform.capitalized) • v\(device.appVersion) • \(device.status)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Privacy") {
                    NavigationLink("Request account deletion") {
                        DeletionRequestView()
                    }
                }

                if let error {
                    Section("Connection") {
                        Text(error)
                            .foregroundStyle(Brand.danger)
                    }
                }

                Section {
                    Button("Sign out", role: .destructive) {
                        Task {
                            await container.signOut()
                        }
                    }
                }
            }
            .navigationTitle("Profile")
            .task {
                await load()
            }
            .refreshable {
                await load()
            }
        }
    }

    private func load() async {
        do {
            async let loadedProfile: Profile = container.api.get("/me", as: Profile.self)
            async let loadedDevices: DevicesPage = container.api.get("/me/devices", as: DevicesPage.self)
            profile = try await loadedProfile
            devices = try await loadedDevices.items
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct DeletionRequestView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var phrase = ""
    @State private var message: String?

    var body: some View {
        Form {
            Section {
                Text("This will immediately deactivate your account. Completed engagement records may be retained where the Privacy Policy requires it.")
            }
            Section("Confirm") {
                TextField("Type DELETE MY ACCOUNT", text: $phrase)
                    .textInputAutocapitalization(.characters)
                Button("Request deletion", role: .destructive) {
                    Task {
                        await submit()
                    }
                }
                .disabled(phrase != "DELETE MY ACCOUNT")
            }
            if let message {
                Section {
                    Text(message)
                }
            }
        }
        .navigationTitle("Account deletion")
    }

    private func submit() async {
        struct Body: Encodable {
            let confirmPhrase: String
        }
        struct Reply: Decodable {
            let message: String
        }

        do {
            let reply = try await container.api.post(
                "/me/data-deletion-request",
                body: Body(confirmPhrase: phrase),
                as: Reply.self
            )
            message = reply.message
        } catch {
            message = error.localizedDescription
        }
    }
}
