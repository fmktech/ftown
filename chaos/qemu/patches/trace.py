# Investigation-only instrumentation (build arg TRACE=1, image ftown-chaos-qemu:trace).
# Logs every QEMU_CLOCK_VIRTUAL timer callback and every icount warp to $QEMU_CHAOS_TRACE.
import sys
root = sys.argv[1]
def edit(rel, pairs):
    p = f'{root}/{rel}'
    s = open(p).read()
    for a, b in pairs:
        assert s.count(a) == 1, (rel, a)
        s = s.replace(a, b)
    open(p, 'w').write(s)

edit('util/qemu-timer.c', [
    ('#include "qemu/osdep.h"\n', '''#include "qemu/osdep.h"
#include "hw/core/cpu.h"
void chaos_trace(const char *fmt, ...);
void chaos_trace(const char *fmt, ...)
{
    static FILE *f;
    static int init;
    va_list ap;
    if (!init) {
        const char *p = getenv("QEMU_CHAOS_TRACE");
        init = 1;
        f = p ? fopen(p, "w") : NULL;
    }
    if (!f) {
        return;
    }
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fflush(f);
}
'''),
    ('''        ts->expire_time = -1;
        cb = ts->cb;''', '''        if (timer_list->clock->type == QEMU_CLOCK_VIRTUAL) {
            chaos_trace("T exp=%" PRId64 " now=%" PRId64 " vcpu=%d cb=%" PRIxPTR "\\n",
                        ts->expire_time, current_time, current_cpu != NULL,
                        (uintptr_t)ts->cb - (uintptr_t)&timerlist_run_timers);
        }
        ts->expire_time = -1;
        cb = ts->cb;'''),
])
edit('softmmu/icount.c', [
    ('static bool icount_sleep = true;', 'static bool icount_sleep = true;\nvoid chaos_trace(const char *fmt, ...);'),
    ('''            qatomic_set_i64(&timers_state.qemu_icount_bias,
                            timers_state.qemu_icount_bias + deadline);''', '''            chaos_trace("W icount=%" PRId64 " bias=%" PRId64 " dl=%" PRId64 " vcpu=%d budget=%" PRId64 "\\n",
                        timers_state.qemu_icount, timers_state.qemu_icount_bias, deadline,
                        qemu_in_vcpu_thread(), first_cpu->icount_budget);
            qatomic_set_i64(&timers_state.qemu_icount_bias,
                            timers_state.qemu_icount_bias + deadline);'''),
])

# Round 2: exact instruction position of every interrupt-request service and of every slice
# whose budget was cut short by a QEMU_CLOCK_REALTIME (host) deadline.
edit('softmmu/icount.c', [
    ('void chaos_trace(const char *fmt, ...);', '''void chaos_trace(const char *fmt, ...);
int64_t chaos_icount_now(CPUState *cpu);
int64_t chaos_icount_now(CPUState *cpu)
{
    return qatomic_read_i64(&timers_state.qemu_icount) + cpu->icount_budget
           - (cpu_neg(cpu)->icount_decr.u16.low + cpu->icount_extra);
}'''),
])
edit('accel/tcg/tcg-accel-ops-icount.c', [
    ('''        /* Check realtime timers, because they help with input processing */
        deadline = qemu_soonest_timeout(deadline,
                qemu_clock_deadline_ns_all(QEMU_CLOCK_REALTIME,
                                           QEMU_TIMER_ATTR_ALL));''', '''        /* Check realtime timers, because they help with input processing */
        {
            int64_t rt = qemu_clock_deadline_ns_all(QEMU_CLOCK_REALTIME, QEMU_TIMER_ATTR_ALL);
            void chaos_trace(const char *fmt, ...);
            if (rt >= 0 && (deadline < 0 || rt < deadline)) {
                chaos_trace("R vdl=%" PRId64 " rtdl=%" PRId64 " icount=%" PRId64 "\\n",
                            deadline, rt, icount_get_raw());
            }
        }
        deadline = qemu_soonest_timeout(deadline,
                qemu_clock_deadline_ns_all(QEMU_CLOCK_REALTIME,
                                           QEMU_TIMER_ATTR_ALL));'''),
])
edit('target/i386/tcg/sysemu/seg_helper.c', [
    ('''    interrupt_request = x86_cpu_pending_interrupt(cs, interrupt_request);
    if (!interrupt_request) {
        return false;
    }
''', '''    interrupt_request = x86_cpu_pending_interrupt(cs, interrupt_request);
    if (!interrupt_request) {
        return false;
    }
    {
        void chaos_trace(const char *fmt, ...);
        int64_t chaos_icount_now(CPUState *cpu);
        chaos_trace("I req=%x icount=%" PRId64 " eip=%" PRIx64 "\\n", interrupt_request,
                    chaos_icount_now(cs), (uint64_t)env->eip);
    }
'''),
])
