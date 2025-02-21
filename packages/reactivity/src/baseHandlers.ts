import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { arrayInstrumentations } from './arrayInstrumentations'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import { ITERATE_KEY, track, trigger } from './dep'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*@__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*@__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => Symbol[key as keyof SymbolConstructor])
    .filter(isSymbol),
)

function hasOwnProperty(this: object, key: unknown) {
  // #10455 hasOwnProperty may be called with non-string values
  if (!isSymbol(key)) key = String(key)
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key as string)
}

class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false,
    protected readonly _isShallow = false,
  ) {}

  get(target: Target, key: string | symbol, receiver: object): any {
    if (key === ReactiveFlags.SKIP) return target[ReactiveFlags.SKIP]

    const isReadonly = this._isReadonly,
      isShallow = this._isShallow
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return isShallow
    } else if (key === ReactiveFlags.RAW) {
      // 没有实际设置ReactiveFlags.RAW，是通过代理拦截方式
      // ReactiveFlags.RAW = "__v_raw"
      if (
        receiver ===
          (isReadonly
            ? isShallow
              ? shallowReadonlyMap
              : readonlyMap
            : isShallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        // receiver is not the reactive proxy, but has the same prototype
        // this means the receiver is a user proxy of the reactive proxy
        // 如果receiver不是代理对象，但是有相同的prototype，则receiver是代理对象
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver) // 普通对象和它的代理对象的prototype是相同的
      ) {
        return target // 返回原始对象（代理上的__v_raw对应就是原对象）
      }
      // early return undefined
      return
    }

    const targetIsArray = isArray(target)

    if (!isReadonly) {
      let fn: Function | undefined
      // arrayInstrumentations[key]对应数组一系列方法的重写（包含但不限于：迭代器方法、push、pop...）
      // 调用对应方法，内部会进行依赖收集
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn
      }
      if (key === 'hasOwnProperty') {
        // 假设调用proxy.hasOwnProperty('a')
        // 那么会收集[toRaw(proxy) , 'a' ]的依赖（不管原对象上到底有没有a属性都会收集）
        // 最后返回判断结果，true or false
        return hasOwnProperty
      }
    }

    const res = Reflect.get(
      // 第三个参数对应receiver，有receiver参数对应Reflect.get方法会通过receiver获取对应属性值
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      // TODO:
      // 如果这是一个包装了ref的proxy代理，则返回使用原始ref作为接收器的方法，以便在所有
      // 类方法中不需要调用`toRaw`对ref进行转换
      // 相当于访问target.key，然后触发ref的依赖收集，即[target, value]的收集
      // 如果target是代理，但是key不是value，那么返回ref实例对象上对应的属性，但是应该是没有依赖收集的
      isRef(target) ? target : receiver,
    )

    // 过滤掉Symbol和某些原型属性，即直接返回（不需要收集依赖）
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    if (!isReadonly) {
      // TODO: 依赖收集
      // 如果target是ref实例，那么这里也会收集依赖，以[ref实例, key]的方式把当前依赖存入dep
      // 然后这里ref实例内部收集了一份dep，这里也收集了一份[ref实例, key]存于WeakMap<target, Map<key, Dep>>结构的dep
      // 所以ref对象也可以有代理，然后通过代理set的话，会触发两份dep收集的依赖，当然effect会去重
      track(target, TrackOpTypes.GET, key) // WeakMap<target, Map<key, Dep>>收集effect依赖
    }

    if (isShallow) {
      return res
    }

    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      // 解包ref，跳过数组和整数键的解包
      // TODO:
      // 如果是数组，并且key是索引值，那么取出的ref不自动解包，而是直接返回
      // 否则，返回ref.value，即自动解包
      // 解包访问ref.value，会触发ref.dep收集的依赖
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      // 将返回的值转换为代理。我们在这里进行isObject检查，以避免无效值警告。
      // 还需要懒惰地访问readonly和reactive，以避免循环依赖。

      // TODO: lazy的方式，即需要的时候，或者说访问到的时候才去把访问的属性值对象转换为响应式的（即用reactive包裹）
      // 所以如果是访问属性的嵌套深层属性，那么也能及时的创建reactive代理并且及时的收集依赖🐮
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(false, isShallow)
  }
  // get方法继承自BaseReactiveHandler
  // 设置对象属性
  set(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
    value: unknown,
    receiver: object,
  ): boolean {
    let oldValue = target[key]
    if (!this._isShallow) {
      const isOldValueReadonly = isReadonly(oldValue)
      if (!isShallow(value) && !isReadonly(value)) {
        // 因为一个外层对象被reactive处理后，对象本身及其嵌套的对象类型属性都会被reactive递归包裹，即都会套一层代理
        // 所以这里使用toRaw方法获取原始对象
        // 注意：如果是代理对象内部嵌套了ref对象，那么ref对象应该不会被reactive包裹，所以这里使用toRaw方法还是获取原始ref对象
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      // 原数据不是数组，且原数据是ref对象，新数据不是ref
      // 即设置一个代理对象上的ref属性
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          return false
        } else {
          // TODO: 相当于设置ref对象的value属性，触发ref.set方法，内部会处理effect依赖更新，所以到此结束
          oldValue.value = value // 如果value是对象，ref实现内部会自动调用reactive转换为响应式对象
          return true
        }
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
      // 在浅层模式下，对象被设置为原始值，无论是否为响应性
    }

    const hadKey = // 判断key是否存在于对象上（这里对象指普通对象 or 数组）
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)

    // TODO: 实际set
    const result = Reflect.set(
      target,
      key,
      value,
      // 如果被代理的原对象是一个ref对象，那么此时set的应该是ref对象上的属性
      // 所以如果key是'value'的话，那么会触发ref.dep收集的依赖
      isRef(target) ? target : receiver,
    )

    // don't trigger if target is something up in the prototype chain of original
    // 如果target是原始对象的prototype链上的某个对象，则不触发（因为此时receiver对应的是原始对象，或者原始对象的代理，而target的代理只是原始对象原型链上的“父元素”罢了）
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        // 如果key不存在，则触发add操作
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 如果key存在，且新旧值不相等，则触发set操作
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  deleteProperty(
    target: Record<string | symbol, unknown>,
    key: string | symbol,
  ): boolean {
    const hadKey = hasOwn(target, key)
    const oldValue = target[key]
    const result = Reflect.deleteProperty(target, key)
    if (result && hadKey) {
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }

  has(target: Record<string | symbol, unknown>, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }

  // 当对象发生以下操作时会触发依赖收集:
  // 使用 Object.keys()
  // 使用 for...in 循环
  // 使用 Object.entries()
  // 调用对象的迭代器方法

  // 对象（Object/Array）的获取key的迭代方法
  ownKeys(target: Record<string | symbol, unknown>): (string | symbol)[] {
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY, // 迭代数组keys收集以length作为key的依赖， 对象则是ITERATE_KEY
    )
    return Reflect.ownKeys(target)
  }
}

class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow = false) {
    super(true, isShallow)
  }

  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new MutableReactiveHandler() // 普通对象的代理处理器

export const readonlyHandlers: ProxyHandler<object> =
  /*@__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers: MutableReactiveHandler =
  /*@__PURE__*/ new MutableReactiveHandler(true)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers: ReadonlyReactiveHandler =
  /*@__PURE__*/ new ReadonlyReactiveHandler(true)
