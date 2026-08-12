import SwiftUI
import SanctinelCore

/*
 * The 50 Percent Rule view.
 *
 * The question this screen exists to answer is directional: does anyone own this
 * party, and does this party own anyone. A ring of nineteen identical-looking
 * nodes does not answer it — the previous version listed every party as "2 hops ·
 * Entity · Sectoral Sanctions Identifications List", the same sentence nineteen
 * times. So the direction the data already carries is stated in words, first,
 * and the parties are split by it. The diagram stays for shape and hub
 * detection, below the answer rather than in place of it.
 *
 * Everything here is a display and triage aid over listed relationships only —
 * never a determination, and never a substitute for establishing who actually
 * owns what.
 */
struct NetworkView: View {
    let entityId: String
    let entityName: String

    @Environment(SnapshotService.self) private var service
    @State private var graph: EgoNetworkResult?
    @State private var relations = CentreRelations()
    @State private var depth = 2
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var selection: GraphNode?
    @State private var ownershipOnly = false
    @State private var showDiagram = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if isLoading && graph == nil {
                    LoadingState(message: "Building the network…")
                } else if let errorText {
                    ErrorState(message: errorText) { load() }
                } else if let graph {
                    summaryCard(graph)
                    if graph.edges.isEmpty {
                        isolatedNotice
                    } else {
                        directedSections
                        diagramCard(graph)
                        depthCard
                    }
                    Text(EgoNetworkResult.note)
                        .font(.caption2)
                        .foregroundStyle(Palette.mutedFg)
                        .fixedSize(horizontal: false, vertical: true)
                }
                DisclaimerBanner(compact: true)
            }
            .padding(16)
        }
        .background(Palette.background)
        .navigationTitle("Ownership")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: GraphNode.self) { node in
            NetworkView(entityId: node.id, entityName: node.name)
        }
        .task(id: depth) { load() }
    }

    // MARK: - Summary

    private func summaryCard(_ graph: EgoNetworkResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(graph.centerName.isEmpty ? entityName : graph.centerName)
                .font(.headline)
                .foregroundStyle(Palette.foreground)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                StatTile(value: "\(relations.owners.count)", label: "Owned or controlled by",
                         tint: relations.owners.isEmpty ? Palette.mutedFg : Palette.destructive)
                StatTile(value: "\(relations.owned.count)", label: "Owns or controls",
                         tint: relations.owned.isEmpty ? Palette.mutedFg : Palette.warn)
                StatTile(value: "\(relations.other.count + relations.further.count)", label: "Other in network")
            }

            Text(ruleSentence)
                .font(.caption)
                .foregroundStyle(Palette.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.border, lineWidth: 1))
    }

    private var ruleSentence: String {
        if !relations.owners.isEmpty {
            return "A blocked owner reaches this party under the 50 Percent Rule whether or not it is listed itself. The list states the relationship, not the stake — verify the percentage with the issuing authority."
        }
        if !relations.owned.isEmpty {
            return "Parties this one owns can be caught by the 50 Percent Rule even when they are not listed themselves. The list states the relationship, not the percentage — verify the stake before concluding."
        }
        return "No ownership relationship is recorded here. That is a gap in the list's own relationship data, not evidence that none exists."
    }

    private var isolatedNotice: some View {
        Card(title: "No listed relationships") {
            VStack(alignment: .leading, spacing: 8) {
                Text("This snapshot records no relationship for this party at \(depth) hop\(depth == 1 ? "" : "s"), so there is nothing to draw.")
                    .font(.callout)
                    .foregroundStyle(Palette.body)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Authorities publish relationships unevenly. Ownership that is not on the list will not appear here — check corporate registries before concluding that nothing is caught by the 50 Percent Rule.")
                    .font(.caption)
                    .foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
                if depth < 3 {
                    Button("Try \(depth + 1) hops") { depth += 1 }
                        .font(.callout.weight(.medium))
                }
            }
        }
    }

    // MARK: - Directed lists

    @ViewBuilder
    private var directedSections: some View {
        if !relations.owners.isEmpty {
            linkSection(title: "Owned or controlled by",
                        subtitle: "These parties reach this one under the 50 Percent Rule.",
                        icon: "arrow.down.left.circle.fill",
                        tint: Palette.destructive,
                        links: relations.owners)
        }
        if !relations.owned.isEmpty {
            linkSection(title: "Owns or controls",
                        subtitle: "This party may pull these into scope, listed or not.",
                        icon: "arrow.up.right.circle.fill",
                        tint: Palette.warn,
                        links: relations.owned)
        }
        if !relations.other.isEmpty {
            linkSection(title: "Other listed relationships",
                        subtitle: "Agency, family or support ties. The 50 Percent Rule does not reach these.",
                        icon: "link.circle.fill",
                        tint: Palette.mutedFg,
                        links: relations.other)
        }
        if !relations.further.isEmpty {
            Card(title: "Further out · \(relations.further.count)",
                 subtitle: "Reached through another party, not directly related to this one.") {
                VStack(spacing: 0) {
                    let shown = Array(relations.further.prefix(furtherLimit))
                    ForEach(shown) { node in
                        NodeRow(node: node, type: nil)
                        if node.id != shown.last?.id { Divider() }
                    }
                    if relations.further.count > furtherLimit {
                        Text("+ \(relations.further.count - furtherLimit) more, shown in the diagram below")
                            .font(.caption)
                            .foregroundStyle(Palette.mutedFg)
                            .padding(.top, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private var furtherLimit: Int { 8 }

    private func linkSection(title: String, subtitle: String, icon: String, tint: Color,
                             links: [CentreRelations.Link]) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: icon)
                        .foregroundStyle(tint)
                        .padding(.top, 1)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(title) · \(links.count)")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.foreground)
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(Palette.mutedFg)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                VStack(spacing: 0) {
                    ForEach(links) { link in
                        NodeRow(node: link.node,
                                type: link.statedByCentre
                                    ? link.type
                                    : "their listing: \(link.type)")
                        if link.id != links.last?.id { Divider() }
                    }
                }
            }
        }
    }

    // MARK: - Diagram

    private func diagramCard(_ graph: EgoNetworkResult) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    withAnimation(.snappy(duration: 0.22)) { showDiagram.toggle() }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Network shape")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Palette.foreground)
                            Text("\(graph.nodeCount) parties · \(graph.edgeCount) relationships · \(graph.ownershipEdges) ownership")
                                .font(.caption)
                                .foregroundStyle(Palette.mutedFg)
                        }
                        Spacer()
                        Image(systemName: showDiagram ? "chevron.up" : "chevron.down")
                            .font(.caption)
                            .foregroundStyle(Palette.mutedFg)
                    }
                }
                .buttonStyle(.plain)

                if showDiagram {
                    RadialGraph(graph: graph, ownershipOnly: ownershipOnly, selection: $selection)
                        .frame(height: 320)
                        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    HStack(spacing: 12) {
                        legendItem(color: Palette.destructive, label: "centre")
                        legendItem(color: Palette.primary, label: "1 hop")
                        legendItem(color: Palette.accent, label: "2+")
                        HStack(spacing: 5) {
                            Rectangle().fill(Palette.warn).frame(width: 12, height: 2)
                            Text("ownership").font(.caption2).foregroundStyle(Palette.mutedFg)
                        }
                        Spacer()
                    }
                    Toggle("Ownership edges only", isOn: $ownershipOnly)
                        .font(.caption)
                        .tint(Palette.primary)
                    if let selection {
                        Divider()
                        selectedNode(selection)
                    } else {
                        Text("Tap a node to inspect it. The lists above carry the same parties as text.")
                            .font(.caption2)
                            .foregroundStyle(Palette.mutedFg)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func legendItem(color: Color, label: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(label).font(.caption2).foregroundStyle(Palette.mutedFg)
        }
    }

    private func selectedNode(_ node: GraphNode) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            NodeRow(node: node, type: nil)
            if node.id != entityId, node.inSnapshot {
                NavigationLink(value: node) {
                    Label("Centre the network here", systemImage: "scope")
                        .font(.caption.weight(.medium))
                }
            }
        }
    }

    private var depthCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    Picker("Depth", selection: $depth) {
                        Text("1 hop").tag(1)
                        Text("2 hops").tag(2)
                        Text("3 hops").tag(3)
                    }
                    .pickerStyle(.segmented)
                    if isLoading { ProgressView().controlSize(.mini) }
                }
                Text("One hop is what the 50 Percent Rule reaches directly. Further hops show how the chain continues — each additional link is another relationship to verify, not another determination.")
                    .font(.caption2)
                    .foregroundStyle(Palette.mutedFg)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Loading

    @MainActor
    private func load() {
        guard let relationships = service.relationships else {
            errorText = "The list is still being prepared."
            return
        }
        isLoading = true
        errorText = nil
        let id = entityId
        let hops = depth
        Task {
            // Traversal is local and cheap, but it still runs off the main actor
            // so a three-hop expansion never stutters the view.
            let result = await Task.detached(priority: .userInitiated) {
                relationships.egoNetwork(centerId: id, depth: hops)
            }.value
            if let result {
                graph = result
                relations = result.relations()
                selection = nil
            } else {
                errorText = "This record is not in the list on this device."
            }
            isLoading = false
        }
    }
}

// MARK: - Rows

/// A party in the network. Opens its record — a related party you cannot read is
/// a dead end, and reading it is how the ownership actually gets verified.
struct NodeRow: View {
    @Environment(SnapshotService.self) private var service
    let node: GraphNode
    let type: String?

    private var recordIndex: Int? {
        node.recordIndex ?? service.engine?.recordIndex(forID: node.id)
    }

    var body: some View {
        if let recordIndex, node.inSnapshot {
            NavigationLink(value: HitRoute(recordIndex: recordIndex, match: nil)) {
                content(openable: true)
            }
            .buttonStyle(.plain)
        } else {
            content(openable: false)
        }
    }

    private func content(openable: Bool) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(node.name)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(Palette.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                if let type, !type.isEmpty {
                    Text(type)
                        .font(.caption)
                        .foregroundStyle(Palette.mutedFg)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                Text(subtitle)
                    .font(.caption2)
                    .foregroundStyle(Palette.mutedFg)
                    .lineLimit(1)
                if !node.inSnapshot {
                    Text("Named in a listing but not itself a record here — exactly the shape the 50 Percent Rule is about.")
                        .font(.caption2)
                        .foregroundStyle(Palette.warn)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: openable ? "chevron.right" : "questionmark.circle")
                .font(.caption)
                .foregroundStyle(Palette.mutedFg)
        }
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        var parts: [String] = ["\(node.hop) hop\(node.hop == 1 ? "" : "s")"]
        if !node.type.isEmpty, node.type != "Unknown" { parts.append(node.type) }
        if !node.list.isEmpty { parts.append(node.list) }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Diagram

/// Concentric-ring layout drawn with Canvas. Positions are deterministic — the
/// same network always draws the same way, so two analysts comparing screens are
/// looking at the same picture.
struct RadialGraph: View {
    let graph: EgoNetworkResult
    var ownershipOnly: Bool
    @Binding var selection: GraphNode?

    var body: some View {
        GeometryReader { geo in
            let visible = visibleNodes
            let layout = positions(visible, in: geo.size)
            Canvas { context, size in
                draw(context: context, size: size, layout: layout, nodes: visible)
            }
            .contentShape(Rectangle())
            .onTapGesture { point in
                selection = nearestNode(to: point, layout: layout, nodes: visible)
            }
        }
        .accessibilityLabel("Ownership network diagram with \(visibleNodes.count) parties. The lists above carry the same parties as text.")
    }

    private var visibleEdges: [GraphEdge] {
        ownershipOnly ? graph.edges.filter(\.ownership) : graph.edges
    }

    /// Filtering edges without filtering nodes leaves parties floating with
    /// nothing attached, which reads as "unconnected" rather than "filtered out".
    private var visibleNodes: [GraphNode] {
        guard ownershipOnly else { return graph.nodes }
        var keep = Set<String>([graph.centerId])
        for edge in visibleEdges { keep.insert(edge.source); keep.insert(edge.target) }
        return graph.nodes.filter { keep.contains($0.id) }
    }

    private func positions(_ nodes: [GraphNode], in size: CGSize) -> [String: CGPoint] {
        let centre = CGPoint(x: size.width / 2, y: size.height / 2)
        let maxRadius = min(size.width, size.height) / 2 - 30
        let maxHop = max(1, nodes.map(\.hop).max() ?? 1)

        var byHop: [Int: [GraphNode]] = [:]
        for node in nodes { byHop[node.hop, default: []].append(node) }

        var out: [String: CGPoint] = [:]
        for (hop, hopNodes) in byHop {
            if hop == 0 {
                for node in hopNodes { out[node.id] = centre }
                continue
            }
            let radius = maxRadius * CGFloat(hop) / CGFloat(maxHop)
            // Sort by degree so the busiest parties land in stable positions
            // rather than wherever the traversal happened to reach them.
            let ordered = hopNodes.sorted { ($0.degree, $0.id) > ($1.degree, $1.id) }
            let step = (2 * Double.pi) / Double(max(1, ordered.count))
            // Offset odd rings so nodes on adjacent rings do not line up and hide
            // the edges between them.
            let offset = hop % 2 == 0 ? 0 : step / 2
            for (index, node) in ordered.enumerated() {
                let angle = Double(index) * step + offset - Double.pi / 2
                out[node.id] = CGPoint(x: centre.x + radius * CGFloat(cos(angle)),
                                       y: centre.y + radius * CGFloat(sin(angle)))
            }
        }
        return out
    }

    private func draw(context: GraphicsContext, size: CGSize, layout: [String: CGPoint], nodes: [GraphNode]) {
        let centre = CGPoint(x: size.width / 2, y: size.height / 2)
        let maxRadius = min(size.width, size.height) / 2 - 30
        let maxHop = max(1, nodes.map(\.hop).max() ?? 1)

        for hop in 1...maxHop {
            let radius = maxRadius * CGFloat(hop) / CGFloat(maxHop)
            let rect = CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2)
            context.stroke(Path(ellipseIn: rect), with: .color(Palette.border.opacity(0.7)),
                           style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
        }

        for edge in visibleEdges {
            guard let from = layout[edge.source], let to = layout[edge.target] else { continue }
            var path = Path()
            path.move(to: from)
            path.addLine(to: to)
            let colour = edge.ownership ? Palette.warn.opacity(0.85) : Palette.mutedFg.opacity(0.35)
            context.stroke(path, with: .color(colour), lineWidth: edge.ownership ? 1.6 : 1)
            drawArrowHead(context: context, from: from, to: to, colour: colour)
        }

        for node in nodes {
            guard let point = layout[node.id] else { continue }
            let radius: CGFloat = node.hop == 0 ? 12 : (node.degree > 3 ? 8 : 6)
            let rect = CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
            let fill = hopColor(node.hop)
            context.fill(Path(ellipseIn: rect), with: .color(node.inSnapshot ? fill : Palette.surface))
            context.stroke(Path(ellipseIn: rect),
                           with: .color(node.inSnapshot ? fill : Palette.warn),
                           style: StrokeStyle(lineWidth: node.inSnapshot ? 1 : 2,
                                              dash: node.inSnapshot ? [] : [2, 2]))
            if selection?.id == node.id {
                context.stroke(Path(ellipseIn: rect.insetBy(dx: -5, dy: -5)),
                               with: .color(Palette.foreground), lineWidth: 2)
            }
        }

        // Labels last, and only for the centre, the selection and the single
        // busiest other node. Labelling more of them on a 400-point screen just
        // produces overlapping text nobody can read — the lists above are where
        // the names belong.
        var labelled: [GraphNode] = []
        if let centreNode = nodes.first(where: { $0.hop == 0 }) { labelled.append(centreNode) }
        if let selection, !labelled.contains(where: { $0.id == selection.id }),
           nodes.contains(where: { $0.id == selection.id }) {
            labelled.append(selection)
        }
        if let busiest = nodes.filter({ $0.hop > 0 }).max(by: { $0.degree < $1.degree }),
           !labelled.contains(where: { $0.id == busiest.id }), busiest.degree > 1 {
            labelled.append(busiest)
        }

        for node in labelled {
            guard let point = layout[node.id] else { continue }
            let label = Text(shortName(node.name))
                .font(.system(size: 9, weight: node.hop == 0 ? .bold : .medium))
                .foregroundStyle(Palette.foreground)
            // Push the text outward so it never lands on the ring it belongs to,
            // and keep the centre's own label above its node.
            let dx = point.x - centre.x, dy = point.y - centre.y
            let length = max(1, sqrt(dx * dx + dy * dy))
            let anchor: CGPoint = node.hop == 0
                ? CGPoint(x: point.x, y: point.y - 22)
                : CGPoint(x: point.x + dx / length * 15, y: point.y + dy / length * 15)
            context.draw(label, at: anchor, anchor: .center)
        }
    }

    private func drawArrowHead(context: GraphicsContext, from: CGPoint, to: CGPoint, colour: Color) {
        let dx = to.x - from.x, dy = to.y - from.y
        let length = sqrt(dx * dx + dy * dy)
        guard length > 24 else { return }
        let ux = dx / length, uy = dy / length
        let tip = CGPoint(x: to.x - ux * 10, y: to.y - uy * 10)
        let size: CGFloat = 5
        let left = CGPoint(x: tip.x - ux * size - uy * size * 0.6, y: tip.y - uy * size + ux * size * 0.6)
        let right = CGPoint(x: tip.x - ux * size + uy * size * 0.6, y: tip.y - uy * size - ux * size * 0.6)
        var head = Path()
        head.move(to: tip)
        head.addLine(to: left)
        head.addLine(to: right)
        head.closeSubpath()
        context.fill(head, with: .color(colour))
    }

    private func nearestNode(to point: CGPoint, layout: [String: CGPoint], nodes: [GraphNode]) -> GraphNode? {
        var best: (node: GraphNode, distance: CGFloat)?
        for node in nodes {
            guard let position = layout[node.id] else { continue }
            let distance = hypot(position.x - point.x, position.y - point.y)
            if best == nil || distance < best!.distance { best = (node, distance) }
        }
        guard let best, best.distance < 30 else { return nil }
        return best.node
    }

    private func shortName(_ name: String) -> String {
        name.count <= 22 ? name : String(name.prefix(21)) + "…"
    }
}

func hopColor(_ hop: Int) -> Color {
    switch hop {
    case 0: return Palette.destructive
    case 1: return Palette.primary
    default: return Palette.accent
    }
}
