import Foundation

/*
 * Ego-network extraction — a 1:1 port of lib/graph.js.
 *
 * Builds the LOCAL network around one centre entity, never the full graph,
 * preserving edge direction, type, and whether an edge is an ownership link
 * (which is what the 50 Percent Rule reaches).
 *
 * Output is an investigation aid. Node and edge emphasis is a triage/display
 * signal, NOT an automated suspicious-activity or blocking determination.
 */

public struct GraphNode: Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    public let type: String
    public let list: String
    public let programs: [String]
    public let inSnapshot: Bool
    public let hop: Int
    public var degree: Int = 0
    public var weightedDegree: Int = 0
    /// Index into the engine's records, or nil for a party named by a listing
    /// but absent from the snapshot.
    public let recordIndex: Int?
}

public struct GraphEdge: Sendable, Hashable, Identifiable {
    public let source: String
    public let target: String
    public let type: String
    public let ownership: Bool
    /// "owns", "owned_by", or nil when the edge is control/agency only.
    public let role: String?
    /// "up", "down" or "peer" — how the edge stacks in a hierarchy view.
    public let hier: String
    public var id: String { "\(source)->\(target):\(type)" }
}

public struct EgoNetworkResult: Sendable {
    public let centerId: String
    public let centerName: String
    public let depth: Int
    public let nodes: [GraphNode]
    public let edges: [GraphEdge]
    public let maxNodes: Int
    public var nodeCount: Int { nodes.count }
    public var edgeCount: Int { edges.count }
    public var ownershipEdges: Int { edges.filter(\.ownership).count }
    public var topByDegree: [GraphNode] {
        Array(nodes.sorted { $0.weightedDegree > $1.weightedDegree }.prefix(5))
    }
    public static let note = "Display/triage aid over listed relationships only — not a determination."
}

/// The centre's relationships, split by what they mean for the 50 Percent Rule.
///
/// The direction is the whole point and it is not obvious from the edge alone:
/// an edge runs from the record that carries the relationship to the party it
/// names, and OFAC's wording flips which end is the owner between types. So
/// "Owned or Controlled By" on the centre and "Owns, controls, or operates" on
/// someone else both mean *the other party owns the centre* — and an inverted
/// chain points the analyst at the wrong party.
public struct CentreRelations: Sendable {
    public struct Link: Sendable, Hashable, Identifiable {
        public let node: GraphNode
        public let type: String
        /// True when the relationship wording comes from the CENTRE's own
        /// listing. When it is false the phrasing belongs to the other party's
        /// record and reads from their side — "Owned or Controlled By" under a
        /// heading that says "Owns or controls" is the same fact stated by the
        /// subsidiary, and the UI has to say whose sentence it is or the reader
        /// sees a contradiction.
        public let statedByCentre: Bool
        public var id: String { "\(node.id)|\(type)" }
    }

    /// Parties that own or control the centre.
    public var owners: [Link] = []
    /// Parties the centre owns or controls.
    public var owned: [Link] = []
    /// Listed relationships that carry no ownership — agency, family, support.
    public var other: [Link] = []
    /// Everything beyond the first hop, which the rule does not reach directly.
    public var further: [GraphNode] = []

    public init() {}
}

extension EgoNetworkResult {
    public func relations() -> CentreRelations {
        var out = CentreRelations()
        let byID = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
        var seen = Set<String>()

        for edge in edges {
            let otherID: String
            let centreIsSource: Bool
            if edge.source == centerId { otherID = edge.target; centreIsSource = true }
            else if edge.target == centerId { otherID = edge.source; centreIsSource = false }
            else { continue }
            guard let node = byID[otherID] else { continue }
            let link = CentreRelations.Link(node: node, type: edge.type, statedByCentre: centreIsSource)
            seen.insert(otherID)

            switch edge.role {
            case "owns":
                // source owns target
                if centreIsSource { out.owned.append(link) } else { out.owners.append(link) }
            case "owned_by":
                // target owns source
                if centreIsSource { out.owners.append(link) } else { out.owned.append(link) }
            default:
                out.other.append(link)
            }
        }

        out.further = nodes
            .filter { $0.id != centerId && !seen.contains($0.id) }
            .sorted { ($0.hop, -$0.weightedDegree, $0.name) < ($1.hop, -$1.weightedDegree, $1.name) }
        return out
    }
}

public enum Ownership {
    /// Any relationship the 50 Percent Rule might reach.
    public static func isOwnership(_ type: String) -> Bool {
        let t = type.lowercased()
        return t.contains("own") || t.contains("control") || t.contains("subsid")
            || t.contains("parent") || t.contains("beneficial")
    }

    /*
     * Which end of an ownership edge is the OWNER.
     *
     * An edge runs from the entity carrying the relationship to the party it
     * names, and OFAC's wording flips direction between types: "Owned or
     * Controlled By" means the source is the subsidiary, while "Owns, controls,
     * or operates" means the source is the owner. A hierarchy built on one
     * undirected bucket would invert half the chains — and an inverted 50
     * Percent Rule chain points the analyst at the wrong party.
     */
    public static func role(_ type: String) -> String? {
        let t = type.lowercased()
        // /^owns|owns,|owner of|parent of|controls, or operates/i
        if t.hasPrefix("owns") || t.contains("owns,") || t.contains("owner of")
            || t.contains("parent of") || t.contains("controls, or operates") { return "owns" }
        // /owned|property in the interest of|subsidiary of|controlled by/i
        if t.contains("owned") || t.contains("property in the interest of")
            || t.contains("subsidiary of") || t.contains("controlled by") { return "owned_by" }
        return nil
    }

    /// How the edge stacks in the hierarchy view. OFAC phrases relationships
    /// from the listed party outward ("Acting for or on behalf OF"), so the named
    /// party is the principal and belongs above — which is why unknown types
    /// default to "up".
    public static func direction(_ type: String) -> String {
        switch role(type) {
        case "owns": return "down"
        case "owned_by": return "up"
        default: break
        }
        let t = type.lowercased()
        if t.contains("family") || t.contains("associate") || t.contains("related to")
            || t.contains("spouse") || t.contains("sibling") || t.contains("relative") { return "peer" }
        return "up"
    }
}

/// Directed adjacency over every record's relationships, built once per snapshot.
public final class RelationshipGraph: @unchecked Sendable {
    struct Edge {
        let to: String
        let type: String
        let ownership: Bool
    }

    struct External {
        let id: String
        let name: String
    }

    private(set) var indexById: [String: Int] = [:]
    private var adjacency: [String: [Edge]] = [:]
    private var externals: [String: External] = [:]
    private let records: [ScreeningRecord]

    public init(records: [ScreeningRecord]) {
        self.records = records
        indexById.reserveCapacity(records.count)
        for (i, r) in records.enumerated() where indexById[r.id] == nil { indexById[r.id] = i }

        for record in records {
            let from = record.id
            for rel in record.relationships {
                var to = rel.relatedId
                if to.isEmpty {
                    if rel.relatedName.isEmpty { continue }
                    to = Self.syntheticID(rel.relatedName)
                }
                // Register a synthetic node for a related party not in the
                // snapshot (an unlisted owner) so it still renders — which is
                // exactly the case the 50 Percent Rule is about.
                if indexById[to] == nil, externals[to] == nil {
                    externals[to] = External(id: to, name: rel.relatedName.isEmpty ? "Entity \(to)" : rel.relatedName)
                }
                let ownership = Ownership.isOwnership(rel.type)
                adjacency[from, default: []].append(Edge(to: to, type: rel.type, ownership: ownership))
                adjacency[to, default: []].append(Edge(to: from, type: rel.type, ownership: ownership))
            }
        }
    }

    /// `'name:' + relatedName.toLowerCase().replace(/\s+/g, '_')`
    static func syntheticID(_ name: String) -> String {
        var out = "name:"
        var pendingUnderscore = false
        for ch in name.lowercased() {
            if ch.isWhitespace {
                pendingUnderscore = true
            } else {
                if pendingUnderscore { out.append("_"); pendingUnderscore = false }
                out.append(ch)
            }
        }
        if pendingUnderscore { out.append("_") }
        return out
    }

    public func contains(_ id: String) -> Bool { indexById[id] != nil }

    public func egoNetwork(centerId: String, depth: Int = 2, maxNodes: Int = 300) -> EgoNetworkResult? {
        guard indexById[centerId] != nil else { return nil }

        var hopOf: [String: Int] = [centerId: 0]
        var order: [String] = [centerId]
        var frontier: [String] = [centerId]

        outer: for d in 1...max(1, depth) {
            var next: [String] = []
            for id in frontier {
                // Deterministic expansion, so the same network always draws the
                // same way and two analysts comparing screens see one picture.
                let neighbors = (adjacency[id] ?? []).sorted { $0.to < $1.to }
                for edge in neighbors where hopOf[edge.to] == nil {
                    hopOf[edge.to] = d
                    order.append(edge.to)
                    next.append(edge.to)
                    if hopOf.count >= maxNodes { break outer }
                }
            }
            frontier = next
            if frontier.isEmpty { break }
        }

        var nodes: [GraphNode] = []
        var included = Set<String>()
        for id in order {
            let hop = hopOf[id] ?? 0
            if let idx = indexById[id] {
                let r = records[idx]
                nodes.append(GraphNode(id: id, name: r.name.isEmpty ? "Entity \(id)" : r.name,
                                       type: r.type.isEmpty ? "Unknown" : r.type,
                                       list: r.list, programs: r.programs, inSnapshot: true,
                                       hop: hop, recordIndex: idx))
                included.insert(id)
            } else if let ext = externals[id] {
                nodes.append(GraphNode(id: id, name: ext.name, type: "External", list: "",
                                       programs: [], inSnapshot: false, hop: hop, recordIndex: nil))
                included.insert(id)
            }
        }

        // Directed edges among the included nodes, deduplicated, keeping the
        // outbound direction only.
        var edges: [GraphEdge] = []
        var seen = Set<String>()
        for id in order {
            guard let idx = indexById[id] else { continue }
            for rel in records[idx].relationships {
                var to = rel.relatedId
                if to.isEmpty {
                    if rel.relatedName.isEmpty { continue }
                    to = Self.syntheticID(rel.relatedName)
                }
                guard included.contains(to) else { continue }
                let key = "\(id)->\(to):\(rel.type)"
                if !seen.insert(key).inserted { continue }
                edges.append(GraphEdge(source: id, target: to, type: rel.type,
                                       ownership: Ownership.isOwnership(rel.type),
                                       role: Ownership.role(rel.type),
                                       hier: Ownership.direction(rel.type)))
            }
        }

        // Explainable metrics: degree, and a weighted degree where an ownership
        // edge counts double.
        var degree: [String: Int] = [:]
        var weighted: [String: Int] = [:]
        for edge in edges {
            for id in [edge.source, edge.target] {
                degree[id, default: 0] += 1
                weighted[id, default: 0] += edge.ownership ? 2 : 1
            }
        }
        for i in nodes.indices {
            nodes[i].degree = degree[nodes[i].id] ?? 0
            nodes[i].weightedDegree = weighted[nodes[i].id] ?? 0
        }

        let centerName = nodes.first { $0.id == centerId }?.name ?? ""
        return EgoNetworkResult(centerId: centerId, centerName: centerName, depth: depth,
                                nodes: nodes, edges: edges, maxNodes: maxNodes)
    }
}
