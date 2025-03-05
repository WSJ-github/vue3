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
   * 双向链表的指针
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
   * 当前dep和当前活跃的effect之间的链接（即Link节点）
   */
  activeLink?: Link = undefined // 当前活跃的effect链接

  /**
   * Doubly linked list representing the subscribing effects (tail) 表示订阅效果的双链表（尾部）
   * 订阅者链表的【尾节点】（维护effect链，即Link节点双向链表）
   * 表示当前dep收集的各个effect形成的link链
   */
  subs?: Link = undefined

  /**
   * Doubly linked list representing the subscribing effects (head)
   * DEV only, for invoking onTrigger hooks in correct order
   * 翻译：表示订阅效果的双链表（头部）
   * 开发环境专用，用于在正确顺序中调用onTrigger钩子
   * Link链头
   */
  subsHead?: Link

  /**
   * For object property deps cleanup
   */
  map?: KeyToDepMap = undefined // 用于对象属性依赖清理
  key?: unknown = undefined // 存储当前dep对应的key

  /**
   * Subscriber counter
   * 即dep.subs链中link节点的数量，表示当前dep收集的effect依赖数量（effect.fn中用到当前dep对应的数据属性所以产生关联）
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
   * 微总结：
   * 1. 如果当前没有活跃的effect，或者不应该跟踪，或者【当前effect是计算属性】，则直接返回
   * （TODO:疑问：计算属性不是也是个订阅者身份吗，或者说类似effect的存在，为什么这里副作用是computed就不收集了）
   *  解答：因为这里的this.computed指的是dep.computed，说明dep是一个computed dep，是computed实例内部用来收集其它effect依赖的dep实例，所以如果活跃的effect就是computed本身的话，没必要自己收集自己，会出现循环依赖的问题...
   * 2. 如果当前dep.activeLink为空或者当前activeLink.sub不等于activeSub，那么构建一个关联当前dep和activeSub的link节点，把该link节点插入到activeSub.deps链尾部，并且相应的调整link节点之间的探针指向，最后就是调用addSub(link)，把新link节点插入到dep.subs链尾部，这就构建好了新link节点关联的dep & effect的双边关系
   * 3. 如果当前dep.activeLink不为空 且 this.activeLink.sub等于当前的activeSub，则说明当前link节点已经存在（指当前的dep&effect中），则直接同步版本，然后调整link节点在activeSub.deps链中的位置（活跃link插到尾部）
   * 4. 最后返回当前活跃link节点
   *
   * 其实说白了还是没有link节点就构建，然后维护好当前dep和当前活跃的effect（即activeSub）之间的双向关系，正确调整dep.subs & activeSub.deps中的link节点位置，把这些link节点串联关系维护好
   */
  track(debugInfo?: DebuggerEventExtraInfo): Link | undefined {
    // 如果当前没有活跃的effect，或者不应该跟踪，或者当前effect是计算属性，则直接返回
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return
    }

    let link = this.activeLink
    // link节点为空，或者link.sub不指向当前活跃的副作用（此时副作用一般指effect，effect相当于vue2中的watcher，都属于subscribe，订阅者，而dep，depandency，是收集依赖等待通知的发布者）
    // ❌所以注意有一种情况：this.activeLink.sub !== activeSub，但是链中其实有其他link节点.sub === activeSub，意思就是之前收集过与activeSub关联的link节点，这里好像不会管，而是直接重新构建一个新的关联link节点，插入到dep.subs上
    // ✅对于this.activeLink.sub !== activeSub，只会发生在当前dep没有收集过当前activeSub的情况，因为如果是activeSub二次触发，此时activeSub内部会遍历activeSub.deps链，然后依次把所有link.dep.version置为-1，并且link.dep.activeLink指向当前link，而link.prevActiveLink指向原activeLink(以便后续恢复)
    // 所以这里if条件通过意味着当前dep没有收集过activeSub，即当前dep&activeSub之间没有建立过link
    if (link === undefined || link.sub !== activeSub) {
      // activeSub只是一个effect实例，这里需要维护一个link节点链接effect&dep
      link = this.activeLink = new Link(activeSub, this)

      // add the link to the activeEffect as a dep (as tail)
      // 将link添加到activeEffect的deps链表中（作为尾部）
      // 即调整activeSub.deps链，调整depsTail探针指向，因为需要把最新的link节点插入到deps链表尾部
      if (!activeSub.deps) {
        // 说明当前link是唯一节点
        activeSub.deps = activeSub.depsTail = link
      } else {
        link.prevDep = activeSub.depsTail
        activeSub.depsTail!.nextDep = link
        activeSub.depsTail = link
      }
      // 上面的逻辑把link节点维护到activeSub.deps链中
      // 简述：顾名思义，把该link节点加入到当前dep.subs中（dep.subs即代表链条末尾）
      addSub(link)
    } else if (link.version === -1) {
      // TODO:
      // 说明是对应effect二次触发，因为effect二次触发之前会调用prepareDeps把当前effect相关link.version都置为-1
      // 并且: link.prevActiveLink = link.dep.activeLink; link.dep.activeLink = link;
      // 这些预处理之后，后续如果effect.fn执行过程中，当前dep还能track到，那么就会执行下面的逻辑，把对应link.version恢复，并且调整link节点在activeSub.deps链中的位置
      // 后续effect.fn执行结束后，还会遍历自己的deps链，把那些link.version为-1的link节点从activeSub.deps链中移除，并且link.dep.subs链中也会移除该link节点

      // this.activeLink不为空 且 this.activeLink.sub等于当前的activeSub
      // TODO: 所以此时link === activeLink

      // reused from last run - already a sub, just sync version
      // 从上次运行重用 - 已经是订阅者，只需同步版本
      link.version = this.version

      // If this dep has a next, it means it's not at the tail - move it to the
      // tail. This ensures the effect's dep list is in the order they are
      // accessed during evaluation.
      // 如果这个dep有下一个，则意味着它不在尾部 - 将其移动到尾部。
      // 这确保了effect的dep列表在它们被访问时按顺序排列。

      // 而且说明当前activeSub.deps链中已经有该link节点了，且link节点还不在deps链的尾部，所以这里做个移动操作
      // link.nextDep指的是link.sub即当前activeSub维护的deps链中的下一个link节点，如果有，则把当前活跃link节点从activeSub.deps链中提出来，插到deps链的尾部去
      // TODO: 注意这里只调整link节点在sub.deps链中的位置，而没有调整link节点在dep.subs链中的位置
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
        // TODO: 如果当前link节点是activeSub.deps链的头节点，则需要调整activeSub.deps链的头节点位置指向下一个link节点
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
    this.version++ // TODO: dep.version递增变化时机（实际是否执行想关联的effect.run会根据dep.version是否变化来决定）
    globalVersion++
    this.notify(debugInfo)
  }

  // 通知订阅者
  notify(debugInfo?: DebuggerEventExtraInfo): void {
    // TODO: 使用startBatch和endBatch控制的原因：
    // 因为在这两个函数之间可能会有其它dep实例trigger&notify，此时全局标识会batchDepth++，然而endBatch真正执行时对于--batchDepth > 0是直接return得
    // 所以这就是批处理，只在最后一次endBatch真正去执行 batchedComputed & batchedSub链收集的所有effect
    startBatch()
    try {
      if (__DEV__) {
        // subs are notified and batched in reverse-order and then invoked in
        // original order at the end of the batch, but onTrigger hooks should
        // be invoked in original order here.
        // 翻译：
        // 订阅者按照反序被通知和批处理，然后在批处理结束时按照原始顺序被调用，
        // 但是onTrigger钩子应该在这里按照原始顺序被调用。
        // 待补充：...用户自定义传入的调试信息？
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
      // TODO: 从尾到头触发收集到的依赖的notify，当然后续实际执行的时候其实是反向的，因为要构建batchedSub或batchedComputed链后续才会最终执行
      // 简述：批处理收集是从尾到头，实际执行是从头到尾
      for (let link = this.subs; link; link = link.prevSub) {
        if (link.sub.notify()) {
          // if notify() returns `true`, this is a computed. Also call notify
          // on its dep - it's called here instead of inside computed's notify
          // in order to reduce call stack depth.
          // 翻译：
          // 如果notify()返回true，说明这是一个computed。同时也要调用它的dep的notify方法 -
          // 这里调用而不是在computed的notify内部调用是为了减少调用栈深度。
          // TODO:补充：
          // 因为computed可以作为订阅者，即类似effect，作为依赖被属性dep收集，同时其它effect使用computed的时候也会被computed.dep收集起来
          // 此时dep充当发布者的角色，因此如果源头的属性dep发生变化，该dep.subs某个link是computed，那么会先调用computed.notify()执行computed effect，即computed.fn
          // 执行完后，返回computed.notify返回true，那么我们还需要递归触发computed.dep.notify()，即触发computed.dep收集起来的所有其它的effect依赖
          ;(link.sub as ComputedRefImpl).dep.notify()
          // V2原理过程回顾：
          // v2Computed实现比较简单，每个computed对应到vue实例上维护一个computed watcher，都是lazy的，即访问到才会去执行getter函数，v2中是访问时触发computed watcher.evaluate，pushTarget，让getter中访问到的属性dep收集当前computed watcher
          // 然后popTarger，此时对应属性dep已经收集了computed watcher，同理cwatcher内部已经维护了对应的dep实例列表，此时判断watcher栈上是否还有watcher，如果有（一般是render watcher），那么继续执行cwatcher.depend，让这些属性dep去主动收集render watcher
          // 所以其实rerender过程中，是最初的属性dep触发的，触发cwatcher.update & renderWatcher.update，然后等待scheduler调度执行
          // V3原理：
          // 每个computed对应一个ComputedRefImpl实例，该实例具备三个主要功能，自己充当普通属性通过dep依赖收集，充当effect维护deps link链，充当ref；
          // v2&v3 computed原理对比：
          // 1. 都是lazy的，访问到才会去执行内部维护的getter函数
          // 2. 都是通过属性dep去触发watcher依赖，但是v2是通过属性dep直接触发all watcher，而v3是属性dep先触发computed effect，接着再递归触发computed.dep收集起来的所有其它的effect依赖
        }
      }
    } finally {
      // TODO:
      // 当响应式数据发生变化时,会调用 dep.notify()
      // dep.notify() 会遍历所有订阅的effect,调用它们的 notify() 方法
      // effect的 notify() 会把自己放入批处理队列(batchedSub或batchedComputed)中
      // 最终在 endBatch() 中:
      // 先执行所有computed effect
      // 再执行普通effect队列中的每个effect的 trigger() 方法,这才是真正执行effect函数的地方
      endBatch()
    }
  }
}

function addSub(link: Link) {
  link.dep.sc++
  // effect实例默认就是active&tracking状态
  if (link.sub.flags & EffectFlags.TRACKING) {
    const computed = link.dep.computed
    // computed getting its first subscriber computed实例得到第一个订阅者（意思就是当前computed实例第一次被其它effect依赖，即被副作用函数effect.fn使用到）
    // enable tracking + lazily subscribe to all its deps 启用追踪 + 懒惰订阅所有deps
    // dep.computed存在，说明当前dep是computed实例内部维护的dep实例
    // TODO: 因为computed实例本身既充当订阅者（维护deps链作为effect被其它属性dep收集），也充当发布者（维护dep实例收集依赖并在触发时trigger通知更新）
    // !link.dep.subs说明当前dep还没有收集任何link节点，即没有被任何effect使用到，因为如果使用到就会构建link节点并且插入subs链中，即说明这个dep(computed dep)第一次收集依赖（即effect）
    if (computed && !link.dep.subs) {
      // 因为addSub调用的时候意味着当前dep实例准备收集sub入链中，或者说当前dep实例对应的数据被某个effect（通常是activeSub）使用到了
      computed.flags |= EffectFlags.TRACKING | EffectFlags.DIRTY
      // TODO: computd.deps反应的是computed实例本身作为一个effect，cmoputed.fn执行时使用到其它响应性数据
      // 被他们的属性dep收集起来（构建link节点并记录到dep.subs链中）的同时，自己的deps链也会记录这些数据属性dep实例到computed.deps链中
      // 其实就是反应了dep/link/effect三者之间的关系，只不过这里computed实例充当effect的角色
      for (let l = computed.deps; l; l = l.nextDep) {
        // TODO: 这里其实有点疑惑...🤔
        // 这里其实如果是computed.dep调用addSub方法的话，下面其实就是把关联的sub构成的link节点插到dep.subs末尾即可，然后正确调整该link节点的前后探针
        // 但是这里又遍历的了收集了computed effect的那些数据属性dep，然后如果这些属性dep.subs的尾节点不是当前和computed effect关联的link节点，则需要把该link节点插入到这些属性dep.subs链的末尾
        // 当然单纯这么做没问题，但是它这里没有调整当前link节点的前置探针，感觉可能会导致该属性dep的subs链断裂的问题....
        addSub(l)
      }
    }

    // TODO: subs其实就是链的【尾节点】
    // 下面的操作其实就是：
    // 1. 把当前dep.subs的尾节点取出来（其实就是dep.subs本身）
    // 2. 把当前的活跃link节点插入到dep.subs对应的link链中，并且插入到最后面，正确设置前后link节点首尾探针的指向
    // 3. dep.subs指向链条【尾节点】，即最新的link节点
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
