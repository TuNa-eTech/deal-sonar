// Ambient declaration so desktop-core typechecks before the Host workspace package is linked.
// The real module's surface is described structurally in `backend/host.ts`.
declare module "@dealsonar/native-host" {
  const mod: Record<string, unknown>;
  export = mod;
}
