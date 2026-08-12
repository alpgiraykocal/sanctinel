import Foundation

/*
 * On-disk form of the search corpus and the candidate index.
 *
 * Both are rebuilt only when a new snapshot is imported. A cold launch reads
 * these back instead of re-parsing 52 MB of JSON and re-tokenizing 104k names,
 * which is the difference between a screening tool that is ready when the user
 * opens it and one that makes them wait.
 */

enum CorpusArchive {
    static let magic = "SNCB"
    // 2: records carry countryCodes alongside countryTokens, and birth dates
    //    as parsed intervals instead of bare four-digit years.
    static let version: UInt32 = 2

    static func encode(records: [ScreeningRecord], meta: SnapshotMetaData) -> Data {
        var table = StringTable()

        // Distinct tokens, referenced by index. Interning them here is what keeps
        // the per-name token lists to four bytes each.
        var tokenIDs: [String: UInt32] = [:]
        var tokenOrder: [String] = []
        func tokenID(_ token: Token) -> UInt32 {
            if let existing = tokenIDs[token.text] { return existing }
            let next = UInt32(tokenOrder.count)
            tokenIDs[token.text] = next
            tokenOrder.append(token.text)
            return next
        }

        // Two passes: the body needs string ids, and the table has to be written
        // before them, so the body is built into its own buffer first.
        var body = BinaryWriter()
        body.write(UInt32(records.count))
        for record in records {
            body.write(table.id(record.id))
            body.write(table.id(record.name))
            body.write(table.id(record.authority))
            body.write(table.id(record.list))
            body.write(table.id(record.type))
            body.write(table.id(record.title))
            body.write(table.id(record.datePublished))

            body.write(UInt16(min(record.programs.count, 0xFFFF)))
            for p in record.programs.prefix(0xFFFF) { body.write(table.id(p)) }

            body.write(UInt16(min(record.names.count, 0xFFFF)))
            for name in record.names.prefix(0xFFFF) {
                body.write(table.id(name.name))
                body.write(table.id(name.type))
                var flags: UInt8 = 0
                if name.primary { flags |= 1 }
                if name.lowQuality { flags |= 2 }
                body.write(flags)
                body.write(UInt16(min(name.tokens.count, 0xFFFF)))
                for t in name.tokens.prefix(0xFFFF) { body.write(tokenID(t)) }
            }

            body.write(UInt16(min(record.identifiers.count, 0xFFFF)))
            for id in record.identifiers.prefix(0xFFFF) {
                body.write(table.id(id.type))
                body.write(table.id(id.value))
                body.write(table.id(id.key))
            }

            body.write(UInt8(min(record.birthIntervals.count, 0xFF)))
            for iv in record.birthIntervals.prefix(0xFF) {
                body.write(table.id(iv.from))
                body.write(table.id(iv.to))
                body.write(table.id(iv.precision))
                body.write(UInt8(iv.approximate ? 1 : 0))
            }

            body.write(UInt16(min(record.countryTokens.count, 0xFFFF)))
            for c in record.countryTokens.prefix(0xFFFF) { body.write(table.id(c)) }

            body.write(UInt16(min(record.countryCodes.count, 0xFFFF)))
            for c in record.countryCodes.prefix(0xFFFF) { body.write(table.id(c)) }

            body.write(UInt16(min(record.relationships.count, 0xFFFF)))
            for rel in record.relationships.prefix(0xFFFF) {
                body.write(table.id(rel.type))
                body.write(table.id(rel.relatedName))
                body.write(table.id(rel.relatedId))
            }
        }

        var out = BinaryWriter()
        out.write(magic: magic)
        out.write(version)
        // Snapshot provenance travels with the corpus so a half-written import
        // can never pair one snapshot's records with another's metadata.
        out.write(bytes: Array(meta.source.utf8))
        out.write(bytes: Array(meta.publicationId.utf8))
        out.write(bytes: Array(meta.publishedDate.utf8))
        out.write(bytes: Array(meta.retrievedAt.utf8))
        out.write(meta.isLive ? UInt8(1) : UInt8(0))
        out.write(UInt32(meta.lists.count))
        for s in meta.lists { out.write(bytes: Array(s.utf8)) }
        out.write(UInt32(meta.programs.count))
        for s in meta.programs { out.write(bytes: Array(s.utf8)) }
        out.write(UInt32(meta.authorities.count))
        for s in meta.authorities { out.write(bytes: Array(s.utf8)) }

        table.write(into: &out)
        out.write(UInt32(tokenOrder.count))
        for t in tokenOrder { out.write(bytes: Array(t.utf8)) }
        out.data.append(body.data)
        return out.data
    }

    struct Decoded {
        let records: [ScreeningRecord]
        let meta: SnapshotMetaData
    }

    static func decode(_ data: Data, pool: TokenPool = TokenPool.shared) throws -> Decoded {
        var reader = BinaryReader(data)
        try reader.expect(magic: magic)
        let fileVersion = try reader.readUInt32()
        guard fileVersion == version else { throw BinaryReader.Failure.badVersion(fileVersion) }

        var meta = SnapshotMetaData()
        meta.source = try reader.readString()
        meta.publicationId = try reader.readString()
        meta.publishedDate = try reader.readString()
        meta.retrievedAt = try reader.readString()
        meta.isLive = try reader.readUInt8() == 1
        meta.lists = try readStrings(&reader)
        meta.programs = try readStrings(&reader)
        meta.authorities = try readStrings(&reader)

        let strings = try StringTable.read(from: &reader)
        let tokenCount = Int(try reader.readUInt32())
        var tokens = [Token]()
        tokens.reserveCapacity(tokenCount)
        for _ in 0..<tokenCount { tokens.append(pool.token(try reader.readString())) }

        func string(_ id: UInt32) throws -> String {
            let i = Int(id)
            guard i < strings.count else { throw BinaryReader.Failure.truncated }
            return strings[i]
        }

        let recordCount = Int(try reader.readUInt32())
        var records = [ScreeningRecord]()
        records.reserveCapacity(recordCount)

        for _ in 0..<recordCount {
            let id = try string(try reader.readUInt32())
            let name = try string(try reader.readUInt32())
            let authority = try string(try reader.readUInt32())
            let list = try string(try reader.readUInt32())
            let type = try string(try reader.readUInt32())
            let title = try string(try reader.readUInt32())
            let datePublished = try string(try reader.readUInt32())

            var programs = [String]()
            let programCount = Int(try reader.readUInt16())
            programs.reserveCapacity(programCount)
            for _ in 0..<programCount { programs.append(try string(try reader.readUInt32())) }

            var names = [ScreeningName]()
            let nameCount = Int(try reader.readUInt16())
            names.reserveCapacity(nameCount)
            for _ in 0..<nameCount {
                let nameText = try string(try reader.readUInt32())
                let typeText = try string(try reader.readUInt32())
                let flags = try reader.readUInt8()
                let tokenCount = Int(try reader.readUInt16())
                var nameTokens = [Token]()
                nameTokens.reserveCapacity(tokenCount)
                for _ in 0..<tokenCount {
                    let index = Int(try reader.readUInt32())
                    guard index < tokens.count else { throw BinaryReader.Failure.truncated }
                    nameTokens.append(tokens[index])
                }
                names.append(ScreeningName(name: nameText, type: typeText,
                                           primary: flags & 1 != 0, lowQuality: flags & 2 != 0,
                                           tokens: nameTokens))
            }

            var identifiers = [ScreeningIdentifier]()
            let identifierCount = Int(try reader.readUInt16())
            identifiers.reserveCapacity(identifierCount)
            for _ in 0..<identifierCount {
                let t = try string(try reader.readUInt32())
                let v = try string(try reader.readUInt32())
                let k = try string(try reader.readUInt32())
                identifiers.append(ScreeningIdentifier(type: t, value: v, key: k))
            }

            var birthIntervals = [DateInterval]()
            let intervalCount = Int(try reader.readUInt8())
            for _ in 0..<intervalCount {
                let from = try string(try reader.readUInt32())
                let to = try string(try reader.readUInt32())
                let precision = try string(try reader.readUInt32())
                let approximate = try reader.readUInt8() == 1
                birthIntervals.append(DateInterval(from: from, to: to,
                                                   precision: precision, approximate: approximate))
            }

            var countryTokens = [String]()
            let countryCount = Int(try reader.readUInt16())
            countryTokens.reserveCapacity(countryCount)
            for _ in 0..<countryCount { countryTokens.append(try string(try reader.readUInt32())) }

            var countryCodes = [String]()
            let codeCount = Int(try reader.readUInt16())
            countryCodes.reserveCapacity(codeCount)
            for _ in 0..<codeCount { countryCodes.append(try string(try reader.readUInt32())) }

            var relationships = [RecordRelationship]()
            let relationshipCount = Int(try reader.readUInt16())
            relationships.reserveCapacity(relationshipCount)
            for _ in 0..<relationshipCount {
                let t = try string(try reader.readUInt32())
                let n = try string(try reader.readUInt32())
                let rid = try string(try reader.readUInt32())
                relationships.append(RecordRelationship(type: t, relatedName: n, relatedId: rid))
            }

            records.append(ScreeningRecord(
                id: id, name: name, authority: authority, list: list, type: type,
                title: title, programs: programs, datePublished: datePublished, names: names,
                identifiers: identifiers, birthIntervals: birthIntervals,
                countryTokens: countryTokens, countryCodes: countryCodes,
                relationships: relationships))
        }

        meta.count = records.count
        return Decoded(records: records, meta: meta)
    }

    private static func readStrings(_ reader: inout BinaryReader) throws -> [String] {
        let count = Int(try reader.readUInt32())
        var out = [String]()
        out.reserveCapacity(count)
        for _ in 0..<count { out.append(try reader.readString()) }
        return out
    }
}

enum IndexArchive {
    static let magic = "SNIX"
    static let version: UInt32 = 1

    static func encode(_ index: SearchIndexData) -> Data {
        var writer = BinaryWriter()
        writer.write(magic: magic)
        writer.write(version)
        writer.write(UInt32(index.count))

        writeNumeric(index.gram, into: &writer) { $0 }
        writeString(index.identifiers, into: &writer)
        writeString(index.acronyms, into: &writer)
        writeNumeric(index.bigrams, into: &writer) { UInt32($0) }
        return writer.data
    }

    static func decode(_ data: Data) throws -> SearchIndexData {
        var reader = BinaryReader(data)
        try reader.expect(magic: magic)
        let fileVersion = try reader.readUInt32()
        guard fileVersion == version else { throw BinaryReader.Failure.badVersion(fileVersion) }

        var out = SearchIndexData()
        out.count = Int(try reader.readUInt32())
        out.gram = try readNumeric(&reader) { $0 }
        out.identifiers = try readString(&reader)
        out.acronyms = try readString(&reader)
        out.bigrams = try readNumeric(&reader) { UInt16(truncatingIfNeeded: $0) }
        return out
    }

    // MARK: - Lanes

    private static func writeNumeric<Key: Hashable>(_ list: PostingList<Key>,
                                                    into writer: inout BinaryWriter,
                                                    encode: (Key) -> UInt32) where Key: BinaryInteger {
        writer.write(UInt32(list.slots.count))
        for (key, slot) in list.slots {
            writer.write(encode(key))
            writer.write(slot)
        }
        writer.write(int32Array: list.offsets)
        writer.write(int32Array: list.values)
        writer.write(uint8Array: list.lengths)
    }

    private static func readNumeric<Key: Hashable>(_ reader: inout BinaryReader,
                                                   decode: (UInt32) -> Key) throws -> PostingList<Key> {
        var out = PostingList<Key>()
        let count = Int(try reader.readUInt32())
        out.slots.reserveCapacity(count)
        for _ in 0..<count {
            let key = decode(try reader.readUInt32())
            out.slots[key] = try reader.readInt32()
        }
        out.offsets = try reader.readInt32Array()
        out.values = try reader.readInt32Array()
        out.lengths = try reader.readUInt8Array()
        return out
    }

    private static func writeString(_ list: PostingList<String>, into writer: inout BinaryWriter) {
        writer.write(UInt32(list.slots.count))
        for (key, slot) in list.slots {
            writer.write(bytes: Array(key.utf8))
            writer.write(slot)
        }
        writer.write(int32Array: list.offsets)
        writer.write(int32Array: list.values)
        writer.write(uint8Array: list.lengths)
    }

    private static func readString(_ reader: inout BinaryReader) throws -> PostingList<String> {
        var out = PostingList<String>()
        let count = Int(try reader.readUInt32())
        out.slots.reserveCapacity(count)
        for _ in 0..<count {
            let key = try reader.readString()
            out.slots[key] = try reader.readInt32()
        }
        out.offsets = try reader.readInt32Array()
        out.values = try reader.readInt32Array()
        out.lengths = try reader.readUInt8Array()
        return out
    }
}
