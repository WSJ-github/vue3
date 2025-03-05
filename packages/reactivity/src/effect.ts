import { extend, hasChanged } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import type { TrackOpTypes, TriggerOpTypes } from './constants'
import { type Link, globalVersion } from './dep'
import { activeEffectScope } from './effectScope'
import { warn } from './warning'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: Subscriber
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  scheduler?: EffectScheduler
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export let activeSub: Subscriber | undefined

export enum EffectFlags {
  /**
   * ReactiveEffect only
   */
  ACTIVE = 1 << 0, // 00000001 活跃（effect实例初始状态之一，调用effect.stop清理所有deps link，此时才非活跃）
  RUNNING = 1 << 1, // 00000010 运行 (依赖运行中，运行结束清理标记)
  TRACKING = 1 << 2, // 00000100 追踪（effect实例初始状态之一）
  NOTIFIED = 1 << 3, // 00001000 通知（effect.notify运行时设置，主要为了避免同一个dep.subs触发过程中重复notify同一个effect，因为会先收集起来，然后到endBatch时依次触发）
  DIRTY = 1 << 4, // 00010000 脏（主要用在computed effect中，也是computed实例的初始状态）
  ALLOW_RECURSE = 1 << 5, // 00100000 允许递归
  PAUSED = 1 << 6, // 01000000 暂停
}

/**
 * Subscriber is a type that tracks (or subscribes to) a list of deps.
 */
export interface Subscriber extends DebuggerOptions {
  /**
   * Head of the doubly linked list representing the deps
   * @internal
   */
  deps?: Link // 订阅者链表的头节点
  /**
   * Tail of the same list
   * @internal
   */
  depsTail?: Link // 订阅者链表的尾节点
  /**
   * @internal
   */
  flags: EffectFlags
  /**
   * @internal
   */
  next?: Subscriber
  /**
   * returning `true` indicates it's a computed that needs to call notify
   * on its dep too
   * @internal
   */
  notify(): true | void
}

const pausedQueueEffects = new WeakSet<ReactiveEffect>()

// ReactiveEffect 实现了 Subscriber 接口，所以每个effect实例都是一个订阅者
export class ReactiveEffect<T = any>
  implements Subscriber, ReactiveEffectOptions
{
  /**
   * @internal
   */
  deps?: Link = undefined
  /**
   * @internal
   */
  depsTail?: Link = undefined
  /**
   * @internal
   * 1 ｜ 4 = 5，即默认是0101，既是active又是tracking状态（因为他们状态位置都是1）
   */
  flags: EffectFlags = EffectFlags.ACTIVE | EffectFlags.TRACKING
  /**
   * @internal
   */
  // effect & computed都是实现Subscriber接口的
  next?: Subscriber = undefined
  /**
   * @internal
   */
  cleanup?: () => void = undefined

  scheduler?: EffectScheduler = undefined
  onStop?: () => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void

  constructor(public fn: () => T) {
    if (activeEffectScope && activeEffectScope.active) {
      activeEffectScope.effects.push(this)
    }
  }

  pause(): void {
    this.flags |= EffectFlags.PAUSED // EffectFlags.PAUSED = 1000000
  }

  // pause 对应 resume

  resume(): void {
    if (this.flags & EffectFlags.PAUSED) {
      this.flags &= ~EffectFlags.PAUSED
      if (pausedQueueEffects.has(this)) {
        pausedQueueEffects.delete(this)
        this.trigger()
      }
    }
  }

  /**
   * @internal
   */
  notify(): void {
    if (
      this.flags & EffectFlags.RUNNING &&
      !(this.flags & EffectFlags.ALLOW_RECURSE)
    ) {
      // 如果当前effect是running并且非allow_recurse状态，那么直接return
      return
    }
    if (!(this.flags & EffectFlags.NOTIFIED)) {
      // 非notified状态才触发
      // 触发后，设置当前effect为notified状态，避免重复触发，并且把当前effect设置到batchedSub或者batchedComputed上
      // 并且维护好effect.next（对应前一个effect），所以最后会构建出来两条单向链，即batchedSub和batchedComputed
      // 只是收集构建batchedSub和batchedComputed链，实际执行是在endBatch中（所以相当于现在只是批处理收集阶段）
      batch(this)
    }
  }

  // 运行effect，类似于Vue2 Watcher的run方法
  // TODO: 真正effect触发时机
  run(): T {
    // TODO cleanupEffect

    // effect实例默认状态EffectFlags.ACTIVE & EffectFlags.TRACKING
    if (!(this.flags & EffectFlags.ACTIVE)) {
      // stopped during cleanup
      // 非活跃状态直接执行
      return this.fn()
    }

    this.flags |= EffectFlags.RUNNING
    cleanupEffect(this) // 执行当前effect实例上定义的cleanup函数（当然cleanup是外面给实例强加的，不是自带的）
    prepareDeps(this) // 预处理
    const prevEffect = activeSub // 保存上一个活跃的effect
    const prevShouldTrack = shouldTrack // 保存上一个shouldTrack的值
    activeSub = this // 将当前effect设置为活跃的effect
    shouldTrack = true // 设置shouldTrack为true

    try {
      return this.fn()
    } finally {
      if (__DEV__ && activeSub !== this) {
        warn(
          'Active effect was not restored correctly - ' +
            'this is likely a Vue internal bug.',
        )
      }
      cleanupDeps(this) // 清理无效依赖 & 恢复原link.dep.activeLink
      activeSub = prevEffect // 恢复上一个活跃的effect
      shouldTrack = prevShouldTrack // 恢复上一个shouldTrack的值
      this.flags &= ~EffectFlags.RUNNING // 清除running标志
    }
  }

  // 清理和当前effect相关的所有link节点
  stop(): void {
    if (this.flags & EffectFlags.ACTIVE) {
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link)
      }
      this.deps = this.depsTail = undefined
      cleanupEffect(this)
      this.onStop && this.onStop()
      this.flags &= ~EffectFlags.ACTIVE
    }
  }

  trigger(): void {
    if (this.flags & EffectFlags.PAUSED) {
      pausedQueueEffects.add(this) // 暂停的推入weakset队列pausedQueueEffects
    } else if (this.scheduler) {
      // computed effect会定义scheduler？其实就是一个普通函数？
      // 貌似watcherEffect可以用户自定义传入...🥸
      this.scheduler()
    } else {
      this.runIfDirty()
    }
  }

  /**
   * @internal
   */
  runIfDirty(): void {
    // 条件通过的情况：
    // 1. 任意sub.deps中link.dep.version !== link.version（其实只需要任意dep trigger一下就会不相等了，因为trigger的时候version会++）
    // 2. 是computed dep并且...(内部可能会重新执行computed effect)
    // 3. sub._dirty === true，某些effect实例手动标记（如pinia测试模块）
    if (isDirty(this)) {
      this.run()
    }
  }

  get dirty(): boolean {
    return isDirty(this)
  }
}

/**
 * For debugging
 */
// function printDeps(sub: Subscriber) {
//   let d = sub.deps
//   let ds = []
//   while (d) {
//     ds.push(d)
//     d = d.nextDep
//   }
//   return ds.map(d => ({
//     id: d.id,
//     prev: d.prevDep?.id,
//     next: d.nextDep?.id,
//   }))
// }

let batchDepth = 0
let batchedSub: Subscriber | undefined
let batchedComputed: Subscriber | undefined

export function batch(sub: Subscriber, isComputed = false): void {
  sub.flags |= EffectFlags.NOTIFIED
  if (isComputed) {
    sub.next = batchedComputed
    batchedComputed = sub
    return
  }
  sub.next = batchedSub
  batchedSub = sub
}

/**
 * @internal
 */
export function startBatch(): void {
  batchDepth++
}

/**
 * Run batched effects when all batches have ended
 * 当所有批处理结束时运行批处理效果
 * @internal
 */
export function endBatch(): void {
  // ！！！
  if (--batchDepth > 0) {
    return
  }

  if (batchedComputed) {
    // 实际batchedComputed链中的computed实例并没有做啥，只是把NOTIFIED状态复原了，让batchedComputed链中的computed实例可以重新被触发notify
    // computed的值在其它effect执行过程中，用到时会判断是否需要更新来确认最终的返回值
    let e: Subscriber | undefined = batchedComputed
    batchedComputed = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      e = next
    }
  }

  let error: unknown
  while (batchedSub) {
    let e: Subscriber | undefined = batchedSub
    batchedSub = undefined
    while (e) {
      const next: Subscriber | undefined = e.next
      e.next = undefined
      e.flags &= ~EffectFlags.NOTIFIED
      if (e.flags & EffectFlags.ACTIVE) {
        try {
          // ACTIVE flag is effect-only
          ;(e as ReactiveEffect).trigger()
        } catch (err) {
          if (!error) error = err
        }
      }
      e = next
    }
  }

  if (error) throw error
}

// TODO: prepareDeps是所有类effect（普通effect｜computed）运行时的预处理
// 主要逻辑：
// 1. 遍历computed.deps，让每个link.version = -1，以便后续判断哪些依赖是无效了的（比如本轮effect执行没有用到该属性，所以属性dep和当前effect之间维护的link应该清除，包括从dep.subs & sub.deps中移除）
// 2. 维护link.dep.activeLink = link，即让dep.activeLink指向当前link，并且让link.prevActiveLink = link.dep.activeLink，以便后续可以恢复link.dep.activeLink
function prepareDeps(sub: Subscriber) {
  // Prepare deps for tracking, starting from the head
  for (let link = sub.deps; link; link = link.nextDep) {
    // set all previous deps' (if any) version to -1 so that we can track
    // which ones are unused after the run
    // 将所有先前依赖的版本设置为-1，以便我们可以在运行后跟踪哪些依赖未被使用。
    link.version = -1
    // store previous active sub if link was being used in another context
    // 如果link在另一个上下文中被使用，则存储先前的活跃订阅
    link.prevActiveLink = link.dep.activeLink
    link.dep.activeLink = link
  }
}

// TODO:处理无效的link
// 遍历sub.deps所有link，有link.version === -1的，移除该link节点(sub.deps & link.dep.subs两个地方都要解绑)，适当调整前后link节点指针指向
function cleanupDeps(sub: Subscriber) {
  // Cleanup unsued deps
  let head
  let tail = sub.depsTail
  let link = tail
  // 从尾到头遍历
  while (link) {
    const prev = link.prevDep
    if (link.version === -1) {
      if (link === tail) tail = prev
      // unused - remove it from the dep's subscribing effect list
      // 从link.dep.subs中移除
      removeSub(link)
      // also remove it from this effect's dep list
      // 从link.sub.deps中移除
      removeDep(link)
    } else {
      // The new head is the last node seen which wasn't removed
      // from the doubly-linked list
      head = link
    }

    // restore previous active link if any
    // 恢复之前因为执行依赖而设置的link.dep.activeLink
    link.dep.activeLink = link.prevActiveLink
    link.prevActiveLink = undefined
    link = prev
  }
  // set the new head & tail
  sub.deps = head
  sub.depsTail = tail
}

// 维护的link链上，link节点version和link.dep.version不一致 or link.dep是computed 并且 该computed刷新成功...
// 待定
function isDirty(sub: Subscriber): boolean {
  // sub对应effect；
  // 双向绑定
  // sub.deps是个Link对象实例...或undefined
  // sub.deps是头指针，dep.subs是尾指针
  for (let link = sub.deps; link; link = link.nextDep) {
    if (
      // link.dep.version !== link.version：
      // 首先我们知道link.version的初始值是link.dep.version，而每次dep.trigger都会让dep.version++
      // 所以这个条件满足的前提是每次对应的dep trigger了
      link.dep.version !== link.version ||
      // 或者满足：
      // 是computed dep并且
      (link.dep.computed &&
        (refreshComputed(link.dep.computed) ||
          // ❌🥸这里或条件感觉多余了，因为如果link.dep.version !== link.version在前面就成立了，根本不会走到这里
          // ✅不多余，因为refreshComputed函数内部可能会让link.dep.version++
          link.dep.version !== link.version))
    ) {
      return true
    }
  }
  // @ts-expect-error only for backwards compatibility where libs manually set
  // this flag - e.g. Pinia's testing module
  // 仅用于向后兼容,一些库手动设置此标志 - 例如 Pinia 的测试模块
  if (sub._dirty) {
    return true
  }
  return false
}

/**
 * Returning false indicates the refresh failed
 * 返回false表示刷新失败
 * TODO: 其实主要逻辑就是让computed作为effect，执行computed getter，然后等着被其它dep收集
 * @internal
 */
export function refreshComputed(computed: ComputedRefImpl): undefined {
  if (
    // computed作为effect，即被其它属性dep调用notify方法时，会标识EffectFlags.DIRTY（初始默认值也是） 和 EffectFlags.NOTIFIED
    // EffectFlags.TRACKING在computed.dep首次addSub的时候标记，即computed.dep首次收集其它effect时会被标记上
    // EffectFlags.DIRTY 是computed默认状态，或者 首次收集effect时跟上面触发时机一样，也会带上这个标识
    computed.flags & EffectFlags.TRACKING &&
    !(computed.flags & EffectFlags.DIRTY)
  ) {
    // TRACKING状态 并且 非DIRTY状态 就直接return
    return
  }
  computed.flags &= ~EffectFlags.DIRTY // 清除dirty标志

  // Global version fast path when no reactive changes has happened since
  // last refresh.
  // 当自上次刷新以来没有发生任何反应变化时，全局版本快速路径。
  // 目前发现，dep.trigger时会globalVersion++
  // computed.globalVersion的默认值是【current globalVersion - 1】，所以computed第一次track的时候也不会在这里被return
  if (computed.globalVersion === globalVersion) {
    return
  }
  computed.globalVersion = globalVersion

  const dep = computed.dep // computed本身就是类Ref对象，内部维护有自己的dep实例
  computed.flags |= EffectFlags.RUNNING // computed 设置为running状态
  // In SSR there will be no render effect, so the computed has no subscriber
  // and therefore tracks no deps, thus we cannot rely on the dirty check.
  // Instead, computed always re-evaluate and relies on the globalVersion
  // fast path above for caching.
  if (
    // 所有dep.version（属性dep｜computed dep｜ref dep）默认值为0，
    // 对于dep来说，触发computed effect的时候会递归触发cdep.notify，让dep.version++
    dep.version > 0 &&
    !computed.isSSR &&
    computed.deps &&
    // computed.flags默认是dirty状态 或者 computed.notify调用时也是设置为dirty状态
    // 当然上面代码中清除了dirty标志
    !isDirty(computed)
  ) {
    computed.flags &= ~EffectFlags.RUNNING
    return
  }

  // TODO: 下面的后续逻辑，其实是computed effect的执行逻辑
  const prevSub = activeSub
  const prevShouldTrack = shouldTrack
  activeSub = computed // computed对象本身作为effect
  shouldTrack = true

  try {
    prepareDeps(computed)
    const value = computed.fn(computed._value) // computed getter接收入参是旧值，computed初始时_value为undefined
    if (dep.version === 0 || hasChanged(value, computed._value)) {
      // cdep没trigger 或者 本次重新接孙啊computed值有变化，那么就更新cmoputed内部维护的_value值，并且对应的cdep.version++
      computed._value = value
      dep.version++
    }
  } catch (err) {
    dep.version++
    throw err
  } finally {
    activeSub = prevSub
    shouldTrack = prevShouldTrack
    // 清理effect重新执行过程中的无效依赖（link，包括从link.dep.subs & link.sub.deps中移除）
    cleanupDeps(computed)
    computed.flags &= ~EffectFlags.RUNNING
  }
}

// 从link.dep.subs中移除某个link节点
// 其实就是调整前后link节点指针指向
function removeSub(link: Link, soft = false) {
  const { dep, prevSub, nextSub } = link
  if (prevSub) {
    prevSub.nextSub = nextSub
    link.prevSub = undefined
  }
  if (nextSub) {
    nextSub.prevSub = prevSub
    link.nextSub = undefined
  }
  if (__DEV__ && dep.subsHead === link) {
    // was previous head, point new head to next
    dep.subsHead = nextSub
  }

  // 当前link节点 === dep.subs指向的节点
  // 其实就是尾节点，因为dep.subs是尾指针
  if (dep.subs === link) {
    // was previous tail, point new tail to prev
    dep.subs = prevSub

    // 如果prevSub不存在，说明当前dep.subs链中只有link这一个节点
    // 而且当前dep是一个computed dep
    if (!prevSub && dep.computed) {
      // 补充：当前computed不被任何其它effect所依赖，那么调整computed.flags，并且把computed.deps中所有涉及的link节点在对应的linkdep.subs中移除
      // 因为当前computed已经不被依赖了，也就是不用了，那么对应依赖computed的属性dep，也把对应link节点从自己dep.subs链中移除

      // if computed, unsubscribe it from all its deps so this computed and its
      // value can be GCed
      // 如果computed，则从所有依赖中取消订阅，以便此computed和其值可以被GCed
      dep.computed.flags &= ~EffectFlags.TRACKING
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        // here we are only "soft" unsubscribing because the computed still keeps
        // referencing the deps and the dep should not decrease its sub count
        // 递归移除
        removeSub(l, true)
      }
    }
  }

  if (!soft && !--dep.sc && dep.map) {
    // #11979
    // property dep no longer has effect subscribers, delete it
    // this mostly is for the case where an object is kept in memory but only a
    // subset of its properties is tracked at one time
    // 属性dep不再有effect订阅者，删除它
    // 这主要是针对这种情况：一个对象保持在内存中，但在同一时间只有它的部分属性被追踪
    dep.map.delete(dep.key)
  }
}

function removeDep(link: Link) {
  const { prevDep, nextDep } = link
  if (prevDep) {
    prevDep.nextDep = nextDep
    link.prevDep = undefined
  }
  if (nextDep) {
    nextDep.prevDep = prevDep
    link.nextDep = undefined
  }
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner<T> {
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const e = new ReactiveEffect(fn)
  if (options) {
    extend(e, options) // options直接合并入ReactiveEffect对象实例
  }
  try {
    e.run()
  } catch (err) {
    e.stop()
    throw err
  }
  const runner = e.run.bind(e) as ReactiveEffectRunner
  runner.effect = e
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner): void {
  runner.effect.stop()
}

/**
 * @internal
 */
export let shouldTrack = true
const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking(): void {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking(): void {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * Registers a cleanup function for the current active effect.
 * The cleanup function is called right before the next effect run, or when the
 * effect is stopped.
 *
 * Throws a warning if there is no current active effect. The warning can be
 * suppressed by passing `true` to the second argument.
 *
 * @param fn - the cleanup function to be registered
 * @param failSilently - if `true`, will not throw warning when called without
 * an active effect.
 */
export function onEffectCleanup(fn: () => void, failSilently = false): void {
  if (activeSub instanceof ReactiveEffect) {
    activeSub.cleanup = fn
  } else if (__DEV__ && !failSilently) {
    warn(
      `onEffectCleanup() was called when there was no active effect` +
        ` to associate with.`,
    )
  }
}

function cleanupEffect(e: ReactiveEffect) {
  const { cleanup } = e
  e.cleanup = undefined
  if (cleanup) {
    // run cleanup without active effect
    const prevSub = activeSub
    activeSub = undefined
    try {
      cleanup()
    } finally {
      activeSub = prevSub
    }
  }
}
