/** Minimal in-memory KVNamespace fake covering the operations OAuthProvider needs. */
export function createFakeKvNamespace(): KVNamespace {
  const store = new Map<string, string>();

  const get = (key: string, options?: { type?: string } | string): Promise<unknown> => {
    const value = store.get(key);
    if (value === undefined) return Promise.resolve(null);
    const type = typeof options === "string" ? options : options?.type;
    return Promise.resolve(type === "json" ? (JSON.parse(value) as unknown) : value);
  };

  const fake = {
    get,
    put(key: string, value: string): Promise<void> {
      store.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
    list(options?: {
      prefix?: string;
    }): Promise<{ keys: { name: string }[]; list_complete: true; cursor: "" }> {
      const prefix = options?.prefix ?? "";
      return Promise.resolve({
        keys: [...store.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cursor: "",
      });
    },
    async getWithMetadata(
      key: string,
      options?: { type?: string } | string,
    ): Promise<{ value: unknown; metadata: null }> {
      return { value: await get(key, options), metadata: null };
    },
  };

  return fake as unknown as KVNamespace;
}

export function createFakeExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}
