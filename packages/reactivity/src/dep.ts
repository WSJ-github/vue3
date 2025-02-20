import { extend, isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import { type TrackOpTypes, TriggerOpTypes } from './constants'
import {
  type DebuggerEventExtraInfo,
  EffectFlags,
  type Subscriber,
  activeSub,
  endBatch,
  shouldTrack,
  startBatch,
} from './effect'

/**
 * Incremented every time a reactive change happens
 * This is used to give computed a fast path to avoid re-compute when nothing
 * has changed.
 */
export let globalVersion = 0

/**
 * 表示源(Dep)和订阅者(Effect或Computed)之间的链接。
 * Deps和subs具有多对多的关系 - 每个dep和sub之间的链接都由一个Link实例表示。
 *
 * Link同时也是两个双向链表中的节点 - 一个用于关联的sub追踪其所有deps,
 * 另一个用于关联的dep追踪其所有subs。
 *
 * Represents a link between a source (Dep) and a subscriber (Effect or Computed).
 * Deps and subs have a many-to-many relationship - each link between a
 * dep and a sub is represented by a Link instance.
 *
 * A Link is also a node in two doubly-linked lists - one for the associated
 * sub to track all its deps, and one for the associated dep to track all its
 * subs.
 *
 * @internal
 */
export class Link {
  /**
   * - Before each effect run, all previous dep links' version are reset to -1
   * - During the run, a link's version is synced with the source dep on access
   * - After the run, links with version -1 (that were never used) are cleaned
   *   up
   * 翻译：
   * - 在每次effect运行之前，所有之前的dep链接的version都被重置为-1
   * - 在运行期间，一个链接的version与源dep同步
   * - 在运行之后，version为-1的链接（从未使用过）被清理
   */
  version: number

  /**
   * Pointers for doubly-linked lists
   */
  nextDep?: Link
  prevDep?: Link
  nextSub?: Link
  prevSub?: Link
  prevActiveLink?: Link

  constructor(
    public sub: Subscriber,
    public dep: Dep,
  ) {
    this.version = dep.version // 和对应dep的version同步
    this.nextDep =
      this.prevDep =
      this.nextSub =
      this.prevSub =
      this.prevActiveLink =
        undefined
  }
}

/**
 * @internal
 */
export class Dep {
  version = 0
  /**
   * Link between this dep and the current active effect
   */
  activeLink?: Link = undefined // 当前活跃的effect链接

  /**
   * Doubly linked list representing the subscribing effects (tail) 表示订阅效果的双链表（尾部）
   * 订阅者链表的尾节点（维护effect链，即Link节点双向链表）
   */
  subs?: Link = undefined

  /**
   * Doubly linked list representing the subscribing effects (head)
   * DEV only, for invoking onTrigger hooks in correct order
   * 翻译：表示订阅效果的双链表（头部）
   * 开发环境专用，用于在正确顺序中调用onTrigger钩子
   */
  subsHead?: Link

  /**
   * For object property deps cleanup
   */
  map?: KeyToDepMap = undefined // 用于对象属性依赖清理
  key?: unknown = undefined // 存储当前dep对应的key

  /**
   * Subscriber counter
   */
  sc: number = 0 // 订阅者计数器

  constructor(public computed?: ComputedRefImpl | undefined) {
    if (__DEV__) {
      this.subsHead = undefined
    }
  }

  /**
   * 追踪收集effect依赖
   * @param debugInfo - 调试信息
   * @returns 返回Link实例，如果追踪失败则返回undefined
   */
  track(debugInfo?: DebuggerEventExtraInfo): Link | undefined {
    // 如果当前没有活跃的effect，或者不应该跟踪，或者当前effect是计算属性，则直接返回
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return
    }

    let link = this.activeLink
    if (link === undefined || link.sub !== activeSub) {
      link = this.activeLink = new Link(activeSub, this)

      // add the link to the activeEffect as a dep (as tail)
      // 将link添加到activeEffect的deps链表中（作为尾部）
      if (!activeSub.deps) {
        activeSub.deps = activeSub.depsTail = link
      } else {
        link.prevDep = activeSub.depsTail
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link
      }

      addSub(link)
    } else if (link.version === -1) {
      // reused from last run - already a sub, just sync version
      link.version = this.version

      // If this dep has a next, it means it's not at the tail - move it to the
      // tail. This ensures the effect's dep list is in the order they are
      // accessed during evaluation.
      // 翻译：
      // 如果这个dep有下一个，则意味着它不在尾部 - 将其移动到尾部。
      // 这确保了effect的dep列表在它们被访问时按顺序排列。
      if (link.nextDep) {
        const next = link.nextDep
        next.prevDep = link.prevDep
        if (link.prevDep) {
          link.prevDep.nextDep = next
        }

        link.prevDep = activeSub.depsTail
        link.nextDep = undefined
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link

        // this was the head - point to the new head
        if (activeSub.deps === link) {
          activeSub.deps = next
        }
      }
    }

    if (__DEV__ && activeSub.onTrack) {
      activeSub.onTrack(
        extend(
          {
            effect: activeSub,
          },
          debugInfo,
        ),
      )
    }

    return link
  }

  // 触发依赖更新
  trigger(debugInfo?: DebuggerEventExtraInfo): void {
    this.version++
    globalVersion++
    this.notify(debugInfo)
  }

  // 通知订阅者
  notify(debugInfo?: DebuggerEventExtraInfo): void {
    startBatch()
    try {
      if (__DEV__) {
        // subs are notified and batched in reverse-order and then invoked in
        // original order at the end of the batch, but onTrigger hooks should
        // be invoked in original order here.
        for (let head = this.subsHead; head; head = head.nextSub) {
          if (head.sub.onTrigger && !(head.sub.flags & EffectFlags.NOTIFIED)) {
            head.sub.onTrigger(
              extend(
                {
                  effect: head.sub,
                },
                debugInfo,
              ),
            )
          }
        }
      }
      for (let link = this.subs; link; link = link.prevSub) {
        if (link.sub.notify()) {
          // if notify() returns `true`, this is a computed. Also call notify
          // on its dep - it's called here instead of inside computed's notify
          // in order to reduce call stack depth.
          // 翻译：
          // 如果notify()返回true，则这是一个计算属性。
          // 也调用其dep的notify() - 在这里而不是在computed的notify()中调用，
          // 以减少调用栈深度。
          ;(link.sub as ComputedRefImpl).dep.notify()
        }
      }
    } finally {
      endBatch()
    }
  }
}

function addSub(link: Link) {
  link.dep.sc++
  if (link.sub.flags & EffectFlags.TRACKING) {
    const computed = link.dep.computed
    // computed getting its first subscriber
    // enable tracking + lazily subscribe to all its deps
    if (computed && !link.dep.subs) {
      computed.flags |= EffectFlags.TRACKING | EffectFlags.DIRTY
      for (let l = computed.deps; l; l = l.nextDep) {
        addSub(l)
      }
    }

    const currentTail = link.dep.subs
    if (currentTail !== link) {
      link.prevSub = currentTail
      if (currentTail) currentTail.nextSub = link
    }

    if (__DEV__ && link.dep.subsHead === undefined) {
      link.dep.subsHead = link
    }

    link.dep.subs = link
  }
}

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Maps to reduce memory overhead.

// 使用WeakMap存储对象到其属性依赖的映射
type KeyToDepMap = Map<any, Dep>

export const targetMap: WeakMap<object, KeyToDepMap> = new WeakMap()

// 定义了一些特殊的迭代键:
// ITERATE_KEY: 用于对象迭代
// MAP_KEY_ITERATE_KEY: 用于Map键迭代
// ARRAY_ITERATE_KEY: 用于数组迭代

export const ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Object iterate' : '',
)
export const MAP_KEY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Map keys iterate' : '',
)
// 数组上的特殊标识属性
// 存储在 targetMap 结构中: WeakMap<原数组, Map<ARRAY_ITERATE_KEY, Dep>>
export const ARRAY_ITERATE_KEY: unique symbol = Symbol(
  __DEV__ ? 'Array iterate' : '',
)

/**
 * 追踪对响应式属性的访问。
 *
 * 这将检查当前正在运行的 effect,并将其记录为 dep,
 * dep 记录了所有依赖于该响应式属性的 effects。
 *
 * @param target - 持有响应式属性的对象。
 * @param type - 定义对响应式属性的访问类型。
 * @param key - 要追踪的响应式属性的标识符。
 *
 * Tracks access to a reactive property.
 *
 * This will check which effect is running at the moment and record it as dep
 * which records all effects that depend on the reactive property.
 *
 * @param target - Object holding the reactive property.
 * @param type - Defines the type of access to the reactive property.
 * @param key - Identifier of the reactive property to track.
 */
export function track(target: object, type: TrackOpTypes, key: unknown): void {
  if (shouldTrack && activeSub) {
    // activeSub 通常是当前正在执行的副作用函数（effect）
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = new Dep()))
      dep.map = depsMap
      dep.key = key
    }
    if (__DEV__) {
      dep.track({
        target,
        type,
        key,
      })
    } else {
      dep.track() // 建立当前活跃的副作用（effect）与这个依赖的关联
    }
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.
 *
 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 */
// 触发effect依赖更新
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>,
): void {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    globalVersion++
    return
  }
  // 现在是dep，以前是set
  const run = (dep: Dep | undefined) => {
    if (dep) {
      if (__DEV__) {
        dep.trigger({
          target,
          type,
          key,
          newValue,
          oldValue,
          oldTarget,
        })
      } else {
        dep.trigger() // 真正的触发effect依赖更新
      }
    }
  }

  startBatch()

  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(run) // map的forEach方法，遍历map，每次元素对应[value, key]
  } else {
    const targetIsArray = isArray(target)
    const isArrayIndex = targetIsArray && isIntegerKey(key)

    // 数组长度变化
    if (targetIsArray && key === 'length') {
      const newLength = Number(newValue)
      depsMap.forEach((dep, key) => {
        if (
          key === 'length' || // 触发数组长度变化时收集的effect依赖
          key === ARRAY_ITERATE_KEY || // 还触发数组迭代过程中收集的effect依赖
          (!isSymbol(key) && key >= newLength) // 数组索引大于等于新长度的那些索引值属性收集的依赖
        ) {
          run(dep)
        }
      })
    } else {
      // schedule runs for SET | ADD | DELETE
      // TODO: 没啥事基本都是走这里触发对应属性收集的依赖
      if (key !== void 0 || depsMap.has(void 0)) {
        run(depsMap.get(key))
      }

      // schedule ARRAY_ITERATE for any numeric key change (length is handled above)
      // TODO: 数组通过索引设置值时，触发数组迭代过程中收集的effect依赖（即特殊标识ARRAY_ITERATE_KEY上收集的dep）
      // 不管是新增索引还是修改某个索引元素的值都会触发
      if (isArrayIndex) {
        run(depsMap.get(ARRAY_ITERATE_KEY))
      }

      // also run for iteration key on ADD | DELETE | Map.SET
      switch (type) {
        case TriggerOpTypes.ADD:
          if (!targetIsArray) {
            // 当对象发生以下操作时会触发依赖收集:
            // 使用 Object.keys()
            // 使用 for...in 循环
            // 使用 Object.entries()
            // 调用对象的迭代器方法
            // 对象迭代会触发代理的handler.ownKeys方法，会触发依赖收集
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              // 如果对象是Map类型，则触发Map迭代过程中收集的effect依赖
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          } else if (isArrayIndex) {
            // TODO: 数组通过索引新增值时，触发数组长度变化时收集的effect依赖
            run(depsMap.get('length'))
          }
          break
        case TriggerOpTypes.DELETE:
          if (!targetIsArray) {
            // 对象删除属性时，触发对象迭代过程中收集的effect依赖
            run(depsMap.get(ITERATE_KEY))
            if (isMap(target)) {
              // 如果对象是Map类型，则触发Map迭代过程中收集的effect依赖
              run(depsMap.get(MAP_KEY_ITERATE_KEY))
            }
          }
          break
        case TriggerOpTypes.SET:
          if (isMap(target)) {
            // 如果对象是Map类型，则触发Map迭代过程中收集的effect依赖
            run(depsMap.get(ITERATE_KEY))
          }
          break
      }
    }
  }

  endBatch()
}

export function getDepFromReactive(
  object: any,
  key: string | number | symbol,
): Dep | undefined {
  const depMap = targetMap.get(object)
  return depMap && depMap.get(key)
}
