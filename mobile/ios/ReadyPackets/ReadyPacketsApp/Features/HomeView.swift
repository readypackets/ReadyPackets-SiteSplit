import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var dashboard: Dashboard?
    @State private var profile: Profile?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let profile {
                        Text("Welcome, \(profile.displayName)")
                            .font(.largeTitle.bold())
                            .accessibilityAddTraits(.isHeader)
                        Text("Your ReadyPackets work at a glance.")
                            .foregroundStyle(.secondary)
                    }

                    if let dashboard {
                        HStack(spacing: 12) {
                            Metric(
                                title: "Orders",
                                value: "\(dashboard.orderCount)",
                                icon: "tray.full"
                            )
                            Metric(
                                title: "Needs attention",
                                value: "\(dashboard.attentionCount)",
                                icon: "exclamationmark.circle"
                            )
                        }

                        if dashboard.currentOrders.isEmpty {
                            ContentUnavailableView(
                                "No current orders",
                                systemImage: "tray",
                                description: Text("When you have active work, its progress will appear here.")
                            )
                        } else {
                            Text("Current work")
                                .font(.headline)
                            ForEach(dashboard.currentOrders) { order in
                                BrandCard {
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(order.projectName ?? order.publicOrderId)
                                            .font(.headline)
                                            .foregroundStyle(.white)
                                        ProgressView(
                                            value: Double(order.completionPercent),
                                            total: 100
                                        )
                                        .tint(Brand.teal)
                                        .accessibilityLabel("Order progress \(order.completionPercent) percent")
                                        Text(order.currentStage ?? "Status: \(order.status)")
                                            .font(.subheadline)
                                            .foregroundStyle(.white.opacity(0.78))
                                    }
                                }
                            }
                        }
                    }

                    if let error {
                        ContentUnavailableView(
                            "Unable to load your dashboard",
                            systemImage: "wifi.exclamationmark",
                            description: Text(error)
                        )
                    }
                }
                .padding()
            }
            .navigationTitle("Home")
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
            async let loadedDashboard: Dashboard = container.api.get("/dashboard", as: Dashboard.self)
            profile = try await loadedProfile
            dashboard = try await loadedDashboard
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct Metric: View {
    let title: String
    let value: String
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(Brand.gold)
            Text(value)
                .font(.title.bold())
                .foregroundStyle(.white)
            Text(title)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.76))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Brand.navyRaised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
