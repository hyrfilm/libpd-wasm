#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <emscripten/heap.h>
#include "m_pd.h"
#include "s_stuff.h"

/* Diagnostic wrappers for getbytes/resizebytes — invoked because the build
 * passes -Wl,--wrap=getbytes -Wl,--wrap=resizebytes. The "wrap" linker
 * trick rewrites every call to `getbytes` in libpd.a to call our
 * `__wrap_getbytes` instead; `__real_getbytes` calls the original.
 *
 * We print the requested size on failure so we can tell whether the
 * "out of memory" is a real allocation pressure issue (KB-scale) or
 * something reading uninitialized state and producing absurd sizes
 * (GB-scale), which is the signature of leftover stub bugs. */
extern void *__real_getbytes(size_t nbytes);
extern void *__real_resizebytes(void *old, size_t oldsize, size_t newsize);

void *__wrap_getbytes(size_t nbytes) {
    void *ret = __real_getbytes(nbytes);
    if (!ret) {
        char msg[160];
        size_t hs = emscripten_get_heap_size();
        size_t hm = emscripten_get_heap_max();
        snprintf(msg, sizeof(msg),
            "  → diag: getbytes(%zu) NULL, heap=%zu max=%zu",
            nbytes, hs, hm);
        post("%s", msg);
    }
    return ret;
}

void *__wrap_resizebytes(void *old, size_t oldsize, size_t newsize) {
    void *ret = __real_resizebytes(old, oldsize, newsize);
    if (!ret) {
        char msg[160];
        size_t hs = emscripten_get_heap_size();
        size_t hm = emscripten_get_heap_max();
        snprintf(msg, sizeof(msg),
            "  → diag: resizebytes(%zu→%zu) NULL, heap=%zu max=%zu",
            oldsize, newsize, hs, hm);
        post("%s", msg);
    }
    return ret;
}

/* === s_inter.c === */
void sys_microsleep(void)  {}
int  sys_pollgui(void)     { return 0; }
void sys_init_fdpoll(void) {}
void sys_bail(int e)       {}

double sys_getrealtime(void) { return 0.0; }

void sys_lock(void)        {}
void sys_unlock(void)      {}
void pd_globallock(void)   {}
void pd_globalunlock(void) {}

/* The real s_inter.c allocates a t_instanceinter here (held as
 * pd_this->pd_inter) which carries i_inbinbuf, i_fdpoll, GUI flags,
 * the recv buffer, etc. The struct is private to s_inter.c so we can't
 * sizeof() it from outside. A no-op stub leaves INTER == NULL, and
 * every read through pd_this->pd_inter->... returns garbage — that
 * surfaces deep inside the canvas/abstraction loader as bogus
 * "getbytes() failed -- out of memory" cascades.
 *
 * Allocate a generous zero-init blob so any offset pd touches lands in
 * valid memory. The real struct is ~70 KB (NET_MAXPACKETSIZE recvbuf
 * dominates); 128 KB gives ample slack for future struct growth. */
#define LIBPD_INTER_BLOB_SIZE (128 * 1024)

void s_inter_newpdinstance(void) {
    pd_this->pd_inter = (t_instanceinter *)getzbytes(LIBPD_INTER_BLOB_SIZE);
}
void s_inter_freepdinstance(void) {
    if (pd_this->pd_inter) {
        freebytes(pd_this->pd_inter, LIBPD_INTER_BLOB_SIZE);
        pd_this->pd_inter = 0;
    }
}

/* fd polling — no sockets in WASM */
void sys_addpollfn(int fd, t_fdpollfn fn, void *ptr) {}
void sys_rmpollfn(int fd)         {}
void sys_closesocket(int fd)      {}
void sys_sockerror(const char *s) {}
unsigned char *sys_getrecvbuf(unsigned int *size) { if (size) *size = 0; return 0; }

t_socketreceiver *socketreceiver_new(void *owner,
                                     t_socketnotifier nf,
                                     t_socketreceivefn rf,
                                     int udp) { return 0; }
void socketreceiver_free(t_socketreceiver *x)         {}
void socketreceiver_read(t_socketreceiver *x, int fd) {}
void socketreceiver_set_fromaddrfn(t_socketreceiver *x,
                                   t_socketfromaddrfn fn) {}

/* === s_inter_gui.c === */
void sys_vgui(const char *fmt, ...) {}
void sys_gui(const char *s)         {}
int  sys_havegui(void)    { return 0; }
int  sys_havetkproc(void) { return 0; }
void sys_queuegui(void *client, t_glist *glist, t_guicallbackfn f) {}
void sys_unqueuegui(void *client) {}

/* === m_glob.c === */
void glob_quit(void *dummy)               {}
void glob_exit(void *dummy, t_floatarg f) {}   /* note: (int, float) */
void glob_ping(void *dummy)               {}
void glob_watchdog(void *dummy)           {}
void glob_vis(void *dummy, t_floatarg f)  {}

/* === m_sched.c === */
void messqueue_dispatch(void) {}

/* === s_main.c === */
void sys_doneglobinit(void) {}
void sys_gui_preferences(void) {}

/* === s_loader.c ===
 *
 * Must return NULL to signal "no more CPU variants" — sys_get_dllextensions()
 * loops `for (cpu = 0; ; cpu++) { if (!sys_deken_specifier(..., cpu)) break; }`.
 * Returning a non-NULL empty string runs that loop forever, allocating a
 * 1000-byte buffer + a resizebytes() each iteration until the wasm heap
 * is exhausted. Symptom: huge cascades of `getbytes() failed -- out of
 * memory` the moment pd tries to load any external/abstraction.
 *
 * We have no native externals to register in the wasm build anyway, so
 * returning NULL unconditionally is correct (and breaks the loop on the
 * first iteration). */
const char *sys_deken_specifier(char *buf, size_t bufsize,
                                int float_agnostic, int cpu) {
  (void)buf; (void)bufsize; (void)float_agnostic; (void)cpu;
  return NULL;
}

/* === MIDI out bridge ===
 *
 * Pd's MIDI-out objects ([noteout], [ctlout], ELSE's [note.out],
 * [bend.out], etc.) call sys_putmidibyte() to push bytes to the host's
 * MIDI driver. libpd refactored this path: its own equivalent is
 * outmidi_byte(), defined in s_libpdmidi.c, which routes to whatever
 * hook the embedder installed via libpd_set_midibytehook().
 *
 * The basic + cyclone builds didn't reference sys_putmidibyte, so the
 * symbol stayed harmlessly unreferenced. ELSE has six *.out objects
 * that do call it (bend.out, ctl.out, note.out, pgm.out, ptouch.out,
 * touch.out), tripping wasm-ld at link time. Bridging the two names
 * keeps those objects functional and routes MIDI through libpd's hook. */
extern void outmidi_byte(int port, int value);
void sys_putmidibyte(int portno, int byte) {
  outmidi_byte(portno, byte);
}