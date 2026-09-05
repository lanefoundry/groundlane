import { InMemoryDurableRecordStore, type DurableRecordStorePort, type DurableRecord, type NewDurableRecord, type DurableCasResult, type DurableDeleteResult } from "./durable-store.js";

/** Request-local write set: run existing create codecs without publishing state. */
export class DocumentAdmissionStagingStore implements DurableRecordStorePort {
  private readonly local = new InMemoryDurableRecordStore();
  private readonly writes = new Map<string, NewDurableRecord>();
  constructor(private readonly durable: DurableRecordStorePort) {}
  get(key: string): Promise<DurableRecord | null> {
    return this.local.get(key).then((record) => record ?? this.durable.get(key));
  }
  async createIfAbsent(input: NewDurableRecord) {
    const current = await this.get(input.key);
    if (current !== null) return { status: "exists" as const, record: current };
    const created = await this.local.createIfAbsent(input);
    if (created.status === "created") this.writes.set(input.key, input);
    return created;
  }
  compareAndSwap(): Promise<DurableCasResult> {
    return Promise.reject(new Error("Admission staging permits create-only metadata"));
  }
  deleteIfRevision(): Promise<DurableDeleteResult> {
    return Promise.reject(new Error("Admission staging permits create-only metadata"));
  }
  scanExpired() { return Promise.reject(new Error("Admission staging does not dispatch or clean metadata")); }
  records(): readonly NewDurableRecord[] { return [...this.writes.values()]; }
}
