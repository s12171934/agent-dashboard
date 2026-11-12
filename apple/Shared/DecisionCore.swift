import AgentDashboardCore
import Foundation

// Rust owns priming, availability and question identity; Swift owns network I/O and the system UI.
// Each instance is confined to DecisionWatcher's main actor.
final class DecisionCore {
    struct Option: Decodable { let label: String }
    struct Question: Decodable { let header: String?; let question: String; let multiSelect: Bool?; let options: [Option] }
    struct Pending: Decodable { let id: String; let agent: String?; let questions: [Question] }
    struct Session: Decodable { let path: String; let title: String? }
    struct Update: Decodable {
        let pending: [Pending]
        let sessions: [String: Session]
        let new_ids: [String]
        let gone_ids: [String]
    }
    private struct Envelope: Decodable { let ok: Bool; let result: Update?; let error: String? }
    private struct CoreError: LocalizedError {
        let message: String
        var errorDescription: String? { "결정 상태를 읽지 못했습니다: \(message)" }
    }
    private let handle: OpaquePointer

    init() {
        precondition(adash_core_abi_version() == 1, "Unsupported AgentDashboardCore ABI")
        guard let handle = adash_decision_store_new() else { preconditionFailure("Cannot allocate decision store") }
        self.handle = handle
    }
    deinit { adash_decision_store_free(handle) }

    func reset() { adash_decision_store_reset(handle) }

    func apply(_ data: Data) throws -> Update {
        let string = data.withUnsafeBytes { bytes in
            adash_decision_store_apply(handle, bytes.bindMemory(to: UInt8.self).baseAddress, data.count)
        }
        guard let string else { throw CoreError(message: "공용 상태 계층이 응답하지 않았습니다") }
        defer { adash_core_string_free(string) }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(String(cString: string).utf8))
        guard envelope.ok, let result = envelope.result else { throw CoreError(message: envelope.error ?? "잘못된 응답") }
        return result
    }
}
