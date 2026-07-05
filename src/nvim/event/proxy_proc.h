#pragma once

// Stage 4 / Phase 3 (seam 2): the IO-proxy child-process spawn backend. The
// WHOLE thing is wasm-only -- on the native build this header declares nothing
// and proxy_proc.c compiles to an empty object, so the native path is untouched.
//
// NOTE: unlike the other event/*.c files this does NOT use the generated
// `event/proxy_proc.c.generated.h`. Because the declaration generator is a
// line-based parser that ignores the C preprocessor, an __EMSCRIPTEN__-guarded
// file would otherwise get its declarations emitted on the native build too. We
// hand-declare the (few) entry points here, all guarded, so the native build
// never sees them.
//
// There is no ProxyProc struct: the embedding allocation is a LibuvProc (created
// by channel.c / shell.c via libuv_proc_init), and proc_spawn() merely retargets
// the Proc's type to kProcTypeProxy. ALL per-child bookkeeping (the server child
// id and the virtual stdio fds) lives in JS (wasm/nvim_proc_proxy.js), keyed by
// the Proc* handle -- exactly like the fs-proxy keeps its handle table in JS. So
// the backend only ever touches the generic Proc, never any LibuvProc field.

#ifdef __EMSCRIPTEN__

# include "nvim/event/proc.h"

int proxy_proc_spawn(Proc *proc);
void proxy_proc_close(Proc *proc);

#endif  // __EMSCRIPTEN__
