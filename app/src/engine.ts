// The engine in the browser: crates/quire-web compiled to WebAssembly, for the web version
// that runs with no server. The same calls as the desktop app, JSON in and out; the Rust
// side of this plain interface is in crates/quire-web/src/lib.rs.

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  call(cmd: number, cmdLen: number, body: number, bodyLen: number): number;
  result_ptr(): number;
  result_ok(): number;
}

let engine: Promise<Exports> | null = null;

async function load(): Promise<Exports> {
  const url = `${import.meta.env.BASE_URL}quire_web.wasm`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the Quire engine could not be loaded (HTTP ${res.status})`);
  const module = await WebAssembly.compile(await res.arrayBuffer());
  // the zip library links JavaScript bindings for randomness it never uses on the paths we
  // call; anything that did reach one would fail loudly instead of quietly
  const imports: WebAssembly.Imports = {};
  for (const i of WebAssembly.Module.imports(module)) {
    (imports[i.module] ??= {})[i.name] = () => {
      throw new Error(`the Quire engine called ${i.name}, which the browser version doesn't provide`);
    };
  }
  return (await WebAssembly.instantiate(module, imports)).exports as unknown as Exports;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function put(x: Exports, text: string): [number, number] {
  const bytes = encoder.encode(text);
  const ptr = x.alloc(bytes.length);
  new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
  return [ptr, bytes.length];
}

export async function callEngine<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  engine ??= load().catch((e) => {
    engine = null; // try again next time (a dropped connection, say)
    throw e;
  });
  const x = await engine;
  const started = performance.now();
  const [c, cl] = put(x, cmd);
  const [b, bl] = put(x, JSON.stringify(args));
  const len = x.call(c, cl, b, bl);
  const answer = JSON.parse(decoder.decode(new Uint8Array(x.memory.buffer, x.result_ptr(), len)));
  if (!x.result_ok()) throw new Error(String(answer));
  // the engine has no clock in the browser: time the call here
  if (cmd === "report") (answer as { elapsedMs: number }).elapsedMs = performance.now() - started;
  return answer as T;
}
