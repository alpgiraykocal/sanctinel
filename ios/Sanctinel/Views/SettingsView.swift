import SwiftUI
import SanctinelCore

/*
 * The list on this device.
 *
 * One question dominates this screen — *can I rely on what I just searched?* —
 * so it is answered first, in full width and in colour, before any provenance
 * detail. Everything below it exists to back that answer up: where the list came
 * from, when the app last checked, what leaves the device, and where to verify a
 * hit. There is no server setting because there is no server.
 */
struct SettingsView: View {
    @Environment(SnapshotService.self) private var service
    @Environment(RecentStore.self) private var recents
    @State private var showClearConfirm = false
    @State private var showRebuildConfirm = false
    @State private var showProvenance = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    statusCard
                    updateCard
                    provenanceCard
                    privacyCard
                    sourcesCard
                    maintenanceCard
                    footer
                }
                .padding(16)
            }
            .background(Palette.background)
            .navigationTitle("List")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await service.refresh(reason: .manual) }
        }
    }

    // MARK: - Status

    private var statusCard: some View {
        let stale = service.isStale
        let tint = stale ? Palette.destructive : Palette.ok
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: stale ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                    .font(.title2)
                    .foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(stale ? "This list is out of date" : "List is current")
                        .font(.headline)
                        .foregroundStyle(Palette.foreground)
                    Text(publishedLine)
                        .font(.caption)
                        .foregroundStyle(Palette.mutedFg)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: 8) {
                StatTile(value: service.recordCount.formatted(), label: "Records")
                StatTile(value: "\(service.meta.authorities.count)", label: "Authorities")
                StatTile(value: byteText(service.storageBytes), label: "On device")
            }

            if stale {
                Text("Designations published since are not in it. A hit from a stale list looks exactly like a hit from a current one — update before relying on a result.")
                    .font(.caption)
                    .foregroundStyle(Palette.body)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                service.refreshNow()
            } label: {
                HStack(spacing: 8) {
                    if service.isRefreshing {
                        ProgressView().controlSize(.small).tint(Palette.surface)
                    } else {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    Text(service.isRefreshing ? "Updating…" : "Check for a new list")
                        .font(.callout.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .foregroundStyle(Palette.surface)
                .background(tint, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(service.isRefreshing)

            if let message = service.lastRefreshMessage {
                Label(message, systemImage: service.lastRefreshFailed ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(service.lastRefreshFailed ? Palette.destructive : Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(tint.opacity(0.4), lineWidth: 1)
        )
    }

    private var publishedLine: String {
        let published = service.manifest?.publishedDate ?? service.meta.publishedDate
        guard !published.isEmpty else { return "Publication date unknown" }
        return "Published \(DateText.medium(published)) · \(service.ageText)"
    }

    // MARK: - Updating

    private var updateCard: some View {
        Card(title: "How it stays current") {
            VStack(alignment: .leading, spacing: 10) {
                mechanism(icon: "clock.arrow.circlepath",
                          title: "When you open the app",
                          detail: "Checked whenever the stored list has had time to age. This is the one that reliably happens.")
                mechanism(icon: "moon.zzz",
                          title: "In the background",
                          detail: "A refresh is scheduled every 12 hours, but iOS decides when — treat it as a bonus, not a guarantee.")
                mechanism(icon: "hand.tap",
                          title: "On demand",
                          detail: "The button above, or pull to refresh on any screen.")

                Divider()

                LabeledContent("Last checked", value: lastCheckedText)
                    .font(.caption)
                Text("A check that finds nothing new costs almost nothing: the app sends the list's fingerprint and the publisher answers \"unchanged\" without sending the file again.")
                    .font(.caption2)
                    .foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func mechanism(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(Palette.primary)
                .frame(width: 18)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.foreground)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var lastCheckedText: String {
        guard let checked = service.lastCheckedAt else { return "not yet" }
        let relative = RelativeDateTimeFormatter()
        relative.unitsStyle = .full
        return relative.localizedString(for: checked, relativeTo: .now)
    }

    // MARK: - Provenance

    /// Collapsed by default: an analyst needs it to reproduce an alert months
    /// later, not on every visit.
    private var provenanceCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    withAnimation(.snappy(duration: 0.22)) { showProvenance.toggle() }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Provenance")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Palette.foreground)
                            Text("What this list is, and how to cite it later")
                                .font(.caption)
                                .foregroundStyle(Palette.mutedFg)
                        }
                        Spacer()
                        Image(systemName: showProvenance ? "chevron.up" : "chevron.down")
                            .font(.caption)
                            .foregroundStyle(Palette.mutedFg)
                    }
                }
                .buttonStyle(.plain)

                if showProvenance {
                    VStack(alignment: .leading, spacing: 10) {
                        if let source = service.manifest?.source, !source.isEmpty {
                            FieldRow(label: "Sources merged", value: source)
                        }
                        WrapTags(tags: service.meta.authorities.map { ($0, .authority($0)) })
                        if let publication = service.manifest?.publicationId, !publication.isEmpty {
                            FieldRow(label: "Publication id", value: publication, mono: true)
                        }
                        if let published = service.manifest?.publishedDate, !published.isEmpty {
                            FieldRow(label: "Published by the authority", value: DateText.medium(published))
                        }
                        if let imported = service.manifest?.importedAt {
                            FieldRow(label: "Built on this device",
                                     value: imported.formatted(date: .abbreviated, time: .shortened))
                        }
                        if let bytes = service.manifest?.bytes, bytes > 0 {
                            FieldRow(label: "Downloaded", value: byteText(bytes))
                        }
                        Text("The search index, the ownership graph and the statistics are all built here from that one file, so every screen in the app is describing the same list.")
                            .font(.caption2)
                            .foregroundStyle(Palette.mutedFg)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    // MARK: - Privacy

    private var privacyCard: some View {
        Card(title: "Privacy") {
            VStack(alignment: .leading, spacing: 10) {
                privacyRow(icon: "iphone.gen3", tint: Palette.ok,
                           text: "Screening runs entirely on this device. What you search is never transmitted — there is no server to send it to.")
                privacyRow(icon: "arrow.down.circle", tint: Palette.primary,
                           text: "The only network request the app makes is downloading the published list.")
                privacyRow(icon: "clock.arrow.circlepath", tint: Palette.mutedFg,
                           text: "Records you open are remembered on this device so you can step back to them. Queries are not.")

                Divider()

                HStack {
                    Text("Recently opened")
                        .font(.callout)
                        .foregroundStyle(Palette.foreground)
                    Spacer()
                    Text("\(recents.items.count)")
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(Palette.mutedFg)
                    Button("Clear") { showClearConfirm = true }
                        .font(.callout.weight(.medium))
                        .disabled(recents.items.isEmpty)
                }
                .confirmationDialog("Clear the recently opened list?",
                                    isPresented: $showClearConfirm, titleVisibility: .visible) {
                    Button("Clear", role: .destructive) { recents.clear() }
                    Button("Cancel", role: .cancel) {}
                }
            }
        }
    }

    private func privacyRow(icon: String, tint: Color, text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(tint)
                .frame(width: 18)
                .padding(.top, 2)
            Text(text)
                .font(.caption)
                .foregroundStyle(Palette.body)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Sources

    private var sourcesCard: some View {
        Card(title: "Verify a hit here",
             subtitle: "Every result in this app is a lead. The issuing authority's own list is the record.") {
            VStack(spacing: 0) {
                ForEach(Array(Self.authorities.enumerated()), id: \.offset) { index, source in
                    Link(destination: source.url) {
                        HStack(spacing: 10) {
                            Tag(text: source.badge, kind: .authority(source.badge))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(source.name)
                                    .font(.callout)
                                    .foregroundStyle(Palette.foreground)
                                    .multilineTextAlignment(.leading)
                                Text(source.note)
                                    .font(.caption2)
                                    .foregroundStyle(Palette.mutedFg)
                                    .multilineTextAlignment(.leading)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.right")
                                .font(.caption2)
                                .foregroundStyle(Palette.mutedFg)
                        }
                        .padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if index < Self.authorities.count - 1 { Divider() }
                }
            }
        }
    }

    private struct AuthoritySource {
        let badge: String
        let name: String
        let note: String
        let url: URL
    }

    private static let authorities: [AuthoritySource] = [
        .init(badge: "OFAC", name: "Sanctions List Search", note: "U.S. Treasury — SDN and consolidated lists",
              url: URL(string: "https://sanctionssearch.ofac.treas.gov")!),
        .init(badge: "EU", name: "Financial Sanctions Database", note: "European Commission",
              url: URL(string: "https://webgate.ec.europa.eu/fsd/fsf")!),
        .init(badge: "UN", name: "Security Council Consolidated List", note: "United Nations",
              url: URL(string: "https://www.un.org/securitycouncil/content/un-sc-consolidated-list")!),
        .init(badge: "UK", name: "OFSI Consolidated List", note: "HM Treasury",
              url: URL(string: "https://www.gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets")!),
        .init(badge: "BIS", name: "Entity List (EAR part 744)", note: "U.S. Commerce — licence obligations, not asset freezes",
              url: URL(string: "https://www.bis.gov/regulations/ear/744")!),
        .init(badge: "State", name: "DDTC", note: "U.S. State Department — ITAR debarments",
              url: URL(string: "https://www.pmddtc.state.gov")!),
    ]

    // MARK: - Maintenance

    private var maintenanceCard: some View {
        Card(title: "Maintenance") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Discards the downloaded list and rebuilds from the copy shipped inside the app. Use this only if the list on the device looks wrong — it will be older than what you have now, until the next update.")
                    .font(.caption)
                    .foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Rebuild from the bundled list", role: .destructive) { showRebuildConfirm = true }
                    .font(.callout.weight(.medium))
                    .disabled(service.isRefreshing)
                    .confirmationDialog("Discard the downloaded list and rebuild from the copy shipped with the app?",
                                        isPresented: $showRebuildConfirm, titleVisibility: .visible) {
                        Button("Rebuild", role: .destructive) { service.rebuildFromSeed() }
                        Button("Cancel", role: .cancel) {}
                    }
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            DisclaimerBanner()
            HStack {
                Text("Sanctinel \(appVersion)")
                    .font(.caption2)
                    .foregroundStyle(Palette.mutedFg)
                Spacer()
                Text("List data is government public domain")
                    .font(.caption2)
                    .foregroundStyle(Palette.mutedFg)
            }
        }
    }

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }

    private func byteText(_ bytes: Int) -> String {
        guard bytes > 0 else { return "—" }
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
