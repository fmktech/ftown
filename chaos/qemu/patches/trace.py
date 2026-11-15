# SPDX-License-Identifier: GPL-2.0-or-later
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
int chaos_trace_deadline;
bool qemu_in_vcpu_thread(void);
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
            chaos_trace("T exp=%" PRId64 " now=%" PRId64 " tid=%d vcpu=%d halted=%u budget=%" PRId64 " cb=%" PRIxPTR "\\n",
                        ts->expire_time, current_time, qemu_get_thread_id(),
                        qemu_in_vcpu_thread(),
                        first_cpu ? first_cpu->halted : 0,
                        first_cpu ? qatomic_read_i64(&first_cpu->icount_budget) : -1,
                        (uintptr_t)ts->cb - (uintptr_t)&timerlist_run_timers);
        }
        ts->expire_time = -1;
        cb = ts->cb;'''),
    ('''        delta = expire_time - qemu_clock_get_ns(type);''', '''        {
            CPUState *cs = first_cpu;
            int64_t b0 = cs ? qatomic_read_i64(&cs->icount_budget) : -1;
            int low0 = (cs && cs->icount_decr_ptr) ? (int)qatomic_read(&cs->icount_decr_ptr->u16.low) : -1;
            int64_t ex0 = cs ? cs->icount_extra : -1;
            uint32_t halted0 = cs ? cs->halted : 0;
            int64_t clk = qemu_clock_get_ns(type);
            int64_t b1 = cs ? qatomic_read_i64(&cs->icount_budget) : -1;
            int low1 = (cs && cs->icount_decr_ptr) ? (int)qatomic_read(&cs->icount_decr_ptr->u16.low) : -1;
            delta = expire_time - clk;
            if (chaos_trace_deadline && type == QEMU_CLOCK_VIRTUAL) {
                chaos_trace("Q tid=%d exp=%" PRId64 " clk=%" PRId64 " raw=%" PRId64
                            " halted=%u b0=%" PRId64 " b1=%" PRId64
                            " decr0=%d decr1=%d extra=%" PRId64 "\\n",
                            qemu_get_thread_id(), expire_time, clk, delta,
                            halted0, b0, b1, low0, low1, ex0);
            }
        }'''),
])
edit('softmmu/icount.c', [
    ('static bool icount_sleep = true;', 'static bool icount_sleep = true;\nvoid chaos_trace(const char *fmt, ...);\nextern int chaos_trace_deadline;'),
    ('''    deadline = qemu_clock_deadline_ns_all(QEMU_CLOCK_VIRTUAL,
                                          ~QEMU_TIMER_ATTR_EXTERNAL);''', '''    chaos_trace_deadline = 1;
    deadline = qemu_clock_deadline_ns_all(QEMU_CLOCK_VIRTUAL,
                                          ~QEMU_TIMER_ATTR_EXTERNAL);
    chaos_trace_deadline = 0;
    {
        CPUState *cs = first_cpu;
        int64_t b = cs ? qatomic_read_i64(&cs->icount_budget) : -1;
        int low = (cs && cs->icount_decr_ptr) ? (int)qatomic_read(&cs->icount_decr_ptr->u16.low) : -1;
        int64_t ex = cs ? cs->icount_extra : -1;
        chaos_trace("D tid=%d icount=%" PRId64 " bias=%" PRId64 " dl=%" PRId64
                    " halted=%u budget=%" PRId64 " decr=%d extra=%" PRId64 " vcpu=%d\\n",
                    qemu_get_thread_id(),
                    qatomic_read_i64(&timers_state.qemu_icount),
                    qatomic_read_i64(&timers_state.qemu_icount_bias),
                    deadline, cs ? cs->halted : 0, b, low, ex, qemu_in_vcpu_thread());
    }'''),
])
# W is logged at the bias add. PATCH=1 (the default) keeps `deadline`. A recompute
# that adds `dl` is also recognised. TRACE=1 is applied after the functional patch.
w_old = '''            qatomic_set_i64(&timers_state.qemu_icount_bias,
                            timers_state.qemu_icount_bias + deadline);'''
w_new = '''                    qatomic_set_i64(&timers_state.qemu_icount_bias,
                                    timers_state.qemu_icount_bias + dl);'''
w_log = '''            {
                CPUState *wcs = first_cpu;
                int low = (wcs && wcs->icount_decr_ptr) ? (int)qatomic_read(&wcs->icount_decr_ptr->u16.low) : -1;
                chaos_trace("W tid=%d icount=%" PRId64 " bias=%" PRId64 " dl=%" PRId64
                            " halted=%u budget=%" PRId64 " decr=%d extra=%" PRId64 " vcpu=%d\\n",
                            qemu_get_thread_id(),
                            qatomic_read_i64(&timers_state.qemu_icount),
                            qatomic_read_i64(&timers_state.qemu_icount_bias),
                            DLNAME, wcs ? wcs->halted : 0,
                            wcs ? qatomic_read_i64(&wcs->icount_budget) : -1,
                            low, wcs ? wcs->icount_extra : -1, qemu_in_vcpu_thread());
            }
            qatomic_set_i64(&timers_state.qemu_icount_bias,
                            timers_state.qemu_icount_bias + DLNAME);'''
p = f'{root}/softmmu/icount.c'
s = open(p).read()
if s.count(w_new) == 1:
    s = s.replace(w_new, w_log.replace('DLNAME', 'dl'))
elif s.count(w_old) == 1:
    s = s.replace(w_old, w_log.replace('DLNAME', 'deadline'))
else:
    raise SystemExit('no warp bias-add site in softmmu/icount.c')
open(p, 'w').write(s)

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
    ('#include "qemu/osdep.h"\n', '#include "qemu/osdep.h"\n#include <sched.h>\n'),
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
    # Investigation only. With sleep=off the main thread sleeps in ppoll until the
    # vCPU notifies after icount_process_data, so the halted-but-unaccounted window
    # is a few microseconds and did not open in 21 natural pairs. Wake the main
    # thread and yield before publishing the slice so a warp can sample the stale clock.
    ('''void icount_process_data(CPUState *cpu)
{
    /* Account for executed instructions */
    icount_update(cpu);''', '''void icount_process_data(CPUState *cpu)
{
    if (cpu->halted) {
        void chaos_trace(const char *fmt, ...);
        int64_t chaos_icount_now(CPUState *cpu);
        chaos_trace("P icount=%" PRId64 " budget=%" PRId64 " decr=%d extra=%" PRId64 "\\n",
                    chaos_icount_now(cpu), (int64_t)cpu->icount_budget,
                    (int)cpu_neg(cpu)->icount_decr.u16.low, (int64_t)cpu->icount_extra);
        qemu_notify_event();
        sched_yield();
    }
    /* Account for executed instructions */
    icount_update(cpu);'''),
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
