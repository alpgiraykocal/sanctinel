import SwiftUI
import SanctinelCore

/// The full listed record. Order follows the web detail panel: what matched,
/// what the listing prohibits, who the party is, then how to reach the network.
struct EntityDetailView: View {
    let recordIndex: Int
    var match: MatchResult?
    @Environment(SnapshotService.self) private var service
    @Environment(RecentStore.self) private var recents
    @State private var loaded: Entity?

    var body: some View {
        Group {
            if let entity = loaded {
                detail(entity)
            } else {
                LoadingState(message: "Opening the record…")
                    .frame(maxHeight: .infinity)
                    .background(Palette.background)
            }
        }
        .task(id: recordIndex) {
            guard loaded == nil else { return }
            let index = recordIndex
            let service = self.service
            // The full record — addresses, documents, every attribute — is read
            // from disk on demand; only what screening needs stays in memory.
            let dictionary = await Task.detached(priority: .userInitiated) {
                await service.fullRecord(at: index)
            }.value
            if let dictionary, let entity = Entity(dictionary: dictionary) {
                loaded = entity
                recents.record(id: entity.id, name: entity.name,
                               authority: entity.authority, list: entity.list)
            }
        }
    }

    @ViewBuilder
    private func detail(_ entity: Entity) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header(entity)
                if let match { matchEvidence(match) }
                measures(entity)
                if !entity.names.isEmpty { namesCard(entity) }
                if !entity.identifiers.isEmpty { identifiersCard(entity) }
                if !entity.idDocuments.isEmpty { documentsCard(entity) }
                if !entity.addresses.isEmpty { addressesCard(entity) }
                ForEach(entity.attributeGroups, id: \.group) { group in
                    Card(title: group.group) {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(group.items) { item in
                                FieldRow(label: item.label, value: item.value)
                            }
                        }
                    }
                }
                if !entity.relationships.isEmpty { relationshipsCard(entity) }
                if !entity.remarks.isEmpty {
                    Card(title: "Remarks") {
                        Text(entity.remarks)
                            .font(.callout)
                            .foregroundStyle(Palette.body)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                networkLink(entity)
                DisclaimerBanner()
            }
            .padding(16)
        }
        .background(Palette.background)
        .navigationTitle(entity.type.isEmpty ? "Record" : entity.type)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: shareText(entity)) { Image(systemName: "square.and.arrow.up") }
            }
        }
    }

    // MARK: - Sections

    private func header(_ entity: Entity) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(entity.name)
                .font(.title3.weight(.bold))
                .foregroundStyle(Palette.foreground)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if !entity.title.isEmpty {
                Text(entity.title)
                    .font(.subheadline)
                    .foregroundStyle(Palette.body)
            }
            WrapTags(tags: headerTags(entity))
            HStack(spacing: 12) {
                if !entity.datePublished.isEmpty {
                    Label(DateText.medium(entity.datePublished), systemImage: "calendar")
                        .font(.caption)
                        .foregroundStyle(Palette.mutedFg)
                }
                Label("ID \(entity.id)", systemImage: "number")
                    .font(.monoCaption())
                    .foregroundStyle(Palette.mutedFg)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.border, lineWidth: 1))
    }

    private func headerTags(_ entity: Entity) -> [(String, Tag.Kind)] {
        var tags: [(String, Tag.Kind)] = []
        if !entity.authority.isEmpty { tags.append((entity.authority, .authority(entity.authority))) }
        if !entity.list.isEmpty { tags.append((entity.list, .list)) }
        if !entity.type.isEmpty { tags.append((entity.type, .type)) }
        return tags
    }

    private func matchEvidence(_ match: MatchResult) -> some View {
        Card(title: "Why this matched") {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center, spacing: 10) {
                    ScoreBadge(score: match.score)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(match.matchType.isEmpty ? "match" : match.matchType)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(Palette.foreground)
                        if !match.matchedField.isEmpty {
                            Text("on \(match.matchedField)")
                                .font(.caption)
                                .foregroundStyle(Palette.mutedFg)
                        }
                    }
                    Spacer()
                }
                if !match.matchedName.isEmpty {
                    FieldRow(label: "Matched value", value: match.matchedName)
                }
                if !match.explain.isEmpty {
                    FieldRow(label: "Scorer trace", value: match.explain, mono: true)
                }
                if match.conflict {
                    calloutRow(
                        icon: "exclamationmark.triangle.fill",
                        tint: Palette.warn,
                        background: Palette.warnBg,
                        text: "A supplied detail contradicts this record — the name matched but the year of birth or country does not. Verify before dismissing or escalating."
                    )
                }
                if match.corroborated {
                    calloutRow(
                        icon: "checkmark.seal.fill",
                        tint: Palette.ok,
                        background: Palette.okBg,
                        text: "A second supplied detail agrees with this record, which raised the score."
                    )
                }
            }
        }
    }

    private func calloutRow(icon: String, tint: Color, background: Color, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.caption).foregroundStyle(tint)
            Text(text)
                .font(.caption)
                .foregroundStyle(Palette.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func measures(_ entity: Entity) -> some View {
        Card(title: "Restriction",
             subtitle: "What the listing imposes — an export-control listing is a licence obligation, not an asset freeze.") {
            VStack(alignment: .leading, spacing: 10) {
                if entity.sanctionsTypes.isEmpty && entity.programs.isEmpty && entity.legalAuthorities.isEmpty {
                    Text("The snapshot carries no measure detail for this record. Check the issuing authority.")
                        .font(.caption)
                        .foregroundStyle(Palette.mutedFg)
                }
                if !entity.sanctionsTypes.isEmpty {
                    labelled("Measure") {
                        WrapTags(tags: entity.sanctionsTypes.map { ($0, .measure) })
                    }
                }
                if !entity.programs.isEmpty {
                    labelled("Programs") {
                        WrapTags(tags: entity.programs.map { ($0, .program) })
                    }
                }
                if !entity.legalAuthorities.isEmpty {
                    labelled("Legal authority") {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(entity.legalAuthorities, id: \.self) { authority in
                                Text(authority)
                                    .font(.caption)
                                    .foregroundStyle(Palette.body)
                            }
                        }
                    }
                }
            }
        }
    }

    private func labelled<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.caption)
                .foregroundStyle(Palette.mutedFg)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func namesCard(_ entity: Entity) -> some View {
        Card(title: "Names and aliases",
             subtitle: "\(entity.names.count) recorded · low-quality aliases are flagged by the issuing authority as weak") {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(entity.names) { record in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(record.name)
                                .font(.callout.weight(record.primary ? .semibold : .regular))
                                .foregroundStyle(Palette.foreground)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if record.lowQuality {
                                Tag(text: "low quality", kind: .neutral)
                            }
                        }
                        if !record.native.isEmpty, record.native != record.name {
                            Text(record.native)
                                .font(.callout)
                                .foregroundStyle(Palette.body)
                                .textSelection(.enabled)
                        }
                        HStack(spacing: 6) {
                            Text(record.type.isEmpty ? "Alias" : record.type)
                                .font(.caption2)
                                .foregroundStyle(Palette.mutedFg)
                            if !record.script.isEmpty, record.script != "Latin" {
                                Text("· \(record.script)")
                                    .font(.caption2)
                                    .foregroundStyle(Palette.mutedFg)
                            }
                        }
                        if !record.parts.isEmpty {
                            Text(record.parts.joined(separator: " · "))
                                .font(.caption2)
                                .foregroundStyle(Palette.mutedFg)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if record.id != entity.names.last?.id { Divider() }
                }
            }
        }
    }

    private func identifiersCard(_ entity: Entity) -> some View {
        Card(title: "Identifiers",
             subtitle: "Matched exactly — an identifier hit is far stronger evidence than a name hit.") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(entity.identifiers) { identifier in
                    HStack(alignment: .top, spacing: 10) {
                        Text(identifier.type)
                            .font(.caption)
                            .foregroundStyle(Palette.mutedFg)
                            .frame(width: 96, alignment: .leading)
                        Text(identifier.value)
                            .font(.monoBody())
                            .foregroundStyle(Palette.foreground)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    private func documentsCard(_ entity: Entity) -> some View {
        Card(title: "Identity documents") {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(entity.idDocuments) { document in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(document.type)
                                .font(.callout.weight(.medium))
                                .foregroundStyle(Palette.foreground)
                            Text(document.number)
                                .font(.monoBody())
                                .foregroundStyle(Palette.body)
                                .textSelection(.enabled)
                        }
                        HStack(spacing: 10) {
                            if !document.issuingCountry.isEmpty {
                                Text(document.issuingCountry)
                                    .font(.caption2)
                                    .foregroundStyle(Palette.mutedFg)
                            }
                            if !document.issueDate.isEmpty {
                                Text("issued \(DateText.medium(document.issueDate))")
                                    .font(.caption2)
                                    .foregroundStyle(Palette.mutedFg)
                            }
                            if !document.expirationDate.isEmpty {
                                Text("expires \(DateText.medium(document.expirationDate))")
                                    .font(.caption2)
                                    .foregroundStyle(Palette.mutedFg)
                            }
                        }
                    }
                    if document.id != entity.idDocuments.last?.id { Divider() }
                }
            }
        }
    }

    private func addressesCard(_ entity: Entity) -> some View {
        Card(title: "Addresses") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(entity.addresses) { address in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(address.full.isEmpty ? address.country : address.full)
                            .font(.callout)
                            .foregroundStyle(Palette.foreground)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        if !address.country.isEmpty, !address.full.isEmpty {
                            Text(address.country)
                                .font(.caption2)
                                .foregroundStyle(Palette.mutedFg)
                        }
                    }
                }
            }
        }
    }

    private func relationshipsCard(_ entity: Entity) -> some View {
        Card(title: "Listed relationships",
             subtitle: entity.ownershipLinks.isEmpty
                ? "As recorded by the issuing authority."
                : "Ownership edges can pull unlisted parties into scope under the 50 Percent Rule.") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(entity.relationships) { relationship in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: relationship.isOwnership ? "building.2.crop.circle" : "link")
                            .font(.caption)
                            .foregroundStyle(relationship.isOwnership ? Palette.warn : Palette.mutedFg)
                            .padding(.top, 2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(relationship.relatedName)
                                .font(.callout)
                                .foregroundStyle(Palette.foreground)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(relationship.type)
                                .font(.caption)
                                .foregroundStyle(Palette.mutedFg)
                        }
                        Spacer(minLength: 0)
                        if !relationship.relatedId.isEmpty {
                            NavigationLink(value: NetworkRoute(id: relationship.relatedId, name: relationship.relatedName)) {
                                Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                                    .font(.caption)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Ownership network for \(relationship.relatedName)")
                        }
                    }
                }
            }
        }
    }

    private func networkLink(_ entity: Entity) -> some View {
        NavigationLink(value: NetworkRoute(id: entity.id, name: entity.name)) {
            HStack(spacing: 10) {
                Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                    .foregroundStyle(Palette.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Ownership network")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Palette.foreground)
                    Text("Who this party owns, and who owns it")
                        .font(.caption)
                        .foregroundStyle(Palette.mutedFg)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(Palette.mutedFg)
            }
            .padding(14)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    /// Shared text carries the disclaimer with it — a screenshot of a hit
    /// passed to a colleague should never read like a determination.
    private func shareText(_ entity: Entity) -> String {
        var lines = [entity.name]
        if !entity.title.isEmpty { lines.append(entity.title) }
        lines.append("\(entity.authority) · \(entity.list)\(entity.type.isEmpty ? "" : " · \(entity.type)")")
        if !entity.programs.isEmpty { lines.append("Programs: \(entity.programs.joined(separator: ", "))") }
        if !entity.sanctionsTypes.isEmpty { lines.append("Measure: \(entity.sanctionsTypes.joined(separator: ", "))") }
        if !entity.datePublished.isEmpty { lines.append("Designated: \(DateText.medium(entity.datePublished))") }
        lines.append("Record ID: \(entity.id)")
        lines.append("")
        lines.append("Screening lead, not a determination — verify with the issuing authority before any compliance decision.")
        return lines.joined(separator: "\n")
    }
}
