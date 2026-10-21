import SwiftUI

struct OrdersView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var orders: [OrderSummary] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if orders.isEmpty && error == nil {
                    ContentUnavailableView(
                        "No orders",
                        systemImage: "tray",
                        description: Text("Your permitted ReadyPackets orders will appear here.")
                    )
                } else {
                    List {
                        if let error {
                            Text(error)
                                .foregroundStyle(Brand.danger)
                        }

                        ForEach(orders) { order in
                            NavigationLink(value: order) {
                                OrderRow(order: order)
                            }
                        }
                    }
                    .navigationDestination(for: OrderSummary.self) { order in
                        OrderDetailView(order: order)
                    }
                }
            }
            .navigationTitle("Orders")
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
            orders = try await container.api.get("/orders?limit=20", as: OrdersPage.self).items
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct OrderRow: View {
    let order: OrderSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(order.projectName ?? order.publicOrderId)
                .font(.headline)
            Text(order.currentStage ?? order.status)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack {
                ProgressView(value: Double(order.completionPercent), total: 100)
                    .tint(Brand.teal)
                Text("\(order.completionPercent)%")
                    .font(.caption.monospacedDigit())
            }
            if order.attention != "none" {
                Label("Action needed", systemImage: "exclamationmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(Brand.gold)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct OrderDetailView: View {
    @EnvironmentObject private var container: AppContainer
    let order: OrderSummary
    @State private var detail: OrderDetail?
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                BrandCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(detail?.projectName ?? order.projectName ?? order.publicOrderId)
                            .font(.title3.bold())
                            .foregroundStyle(.white)
                        Text(detail?.currentStage ?? order.currentStage ?? order.status)
                            .foregroundStyle(.white.opacity(0.8))
                        ProgressView(
                            value: Double(detail?.completionPercent ?? order.completionPercent),
                            total: 100
                        )
                        .tint(Brand.teal)
                        Text("Payment status: \(detail?.paymentStatus ?? order.paymentStatus)")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.75))
                    }
                }

                GroupBox("Current stage") {
                    Text(detail?.currentStage ?? "The server will show the current permitted action.")
                }
                GroupBox("Files and audio") {
                    Text("Choose files or record audio only for a server-authorized workflow step. This app never decides whether a phase is complete or locked.")
                        .font(.subheadline)
                }
                GroupBox("My Business Packets") {
                    Text("Approved final deliverables appear only after server authorization.")
                        .font(.subheadline)
                }
                if let error {
                    Text(error)
                        .foregroundStyle(Brand.danger)
                }
            }
            .padding()
        }
        .navigationTitle("Order")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await load()
        }
    }

    private func load() async {
        do {
            let encodedID = order.publicOrderId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? order.publicOrderId
            detail = try await container.api.get("/orders/\(encodedID)", as: OrderDetail.self)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
