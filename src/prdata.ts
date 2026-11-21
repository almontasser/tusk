// Pull requests' data, with no DOM or Tauri, so the tests can run it (prdata.test.ts).

/**
 * Values loaded per key, such as your pending review per pull request, where loads can finish out of order. A load
 * stores its value only while it's still its key's latest load, so a slow load never overwrites another key's
 * value, or the value of a newer load of its own key.
 */
export function latestLoads<V>(empty: V) {
  const values = new Map<string, V>();
  const loads = new Map<string, Promise<V>>();
  const store = {
    /** The value of the key's latest finished load, or `empty`. */
    get: (key: string): V => (values.has(key) ? values.get(key)! : empty),
    /**
     * Loads the key again. Its caller gets the load's error; callers that share it through `latest` get the value
     * from before, so a failed refresh doesn't make a pending review look gone.
     */
    load(key: string, read: () => Promise<V>): Promise<V> {
      const done = read().then((value) => {
        if (loads.get(key) === shared) values.set(key, value);
        return value;
      });
      const shared = done.catch(() => store.get(key));
      loads.set(key, shared);
      return done;
    },
    /** The key's latest load, finished or not, so callers share it rather than ask again. */
    latest: (key: string, read: () => Promise<V>): Promise<V> => loads.get(key) ?? store.load(key, read),
    /** Sets the key's value, such as after you change it, and makes loads still on their way out of date. */
    set(key: string, value: V) {
      values.set(key, value);
      loads.set(key, Promise.resolve(value));
    },
  };
  return store;
}
