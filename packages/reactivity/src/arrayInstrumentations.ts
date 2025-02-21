import { TrackOpTypes } from './constants'
import { endBatch, pauseTracking, resetTracking, startBatch } from './effect'
import { isProxy, isShallow, toRaw, toReactive } from './reactive'
import { ARRAY_ITERATE_KEY, track } from './dep'
import { isArray } from '@vue/shared'

/**
 * Track array iteration and return:
 * - if input is reactive: a cloned raw array with reactive values
 * - if input is non-reactive or shallowReactive: the original raw array
 */
export function reactiveReadArray<T>(array: T[]): T[] {
  const raw = toRaw(array)
  if (raw === array) return raw
  track(raw, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  return isShallow(array) ? raw : raw.map(toReactive) // 如果数组是浅响应式的，则返回原始数组；否则返回克隆的原始数组，其中元素是响应式的
}

/**
 * Track array iteration and return raw array
 */
export function shallowReadArray<T>(arr: T[]): T[] {
  // ARRAY_ITERATE_KEY: unique symbol = Symbol(
  // __DEV__ ? 'Array iterate' : '',
  // )
  // 开发环境建立arr[Symbol('Array iterate')]的依赖收集map？
  // TODO: 使用特殊的 ARRAY_ITERATE_KEY 收集当前 effect
  // 用于追踪会影响数组迭代结果的操作
  track((arr = toRaw(arr)), TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  return arr // 返回原数组
}

export const arrayInstrumentations: Record<string | symbol, Function> = <any>{
  __proto__: null,

  // 数组迭代器, 所有对数组的迭代操作都要经过这个方法获取迭代器然后进行迭代取值
  // 每次数组的迭代操作，都会调用扩展方法iterator，使用特殊的 ARRAY_ITERATE_KEY 收集当前 effect
  // 下次数组更新时，可以直接触发该特定属性的依赖收集器，执行相应effect
  // 好处：避免需要追踪每个具体索引，提高了性能和效率
  [Symbol.iterator]() {
    return iterator(this, Symbol.iterator, toReactive) // this对应数组代理对象
  },

  concat(...args: unknown[]) {
    // reactiveReadArray：让原数组ARRAY_ITERATE_KEY属性收集当前活跃的effect，返回克隆的原始数组，其中对象类型的值是被套一层proxy代理转换为响应性对象
    return reactiveReadArray(this).concat(
      ...args.map(x => (isArray(x) ? reactiveReadArray(x) : x)),
    )
  },

  entries() {
    // entries() 方法返回一个新的数组迭代器对象
    // 数组特定标识收集依赖
    // 返回迭代器，每次调用next时，返回的值是[<索引>, <被reactive的元素>]
    return iterator(this, 'entries', (value: [number, unknown]) => {
      value[1] = toReactive(value[1])
      return value
    })
  },

  every(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'every', fn, thisArg, undefined, arguments)
  },

  filter(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'filter', fn, thisArg, v => v.map(toReactive), arguments)
  },

  find(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'find', fn, thisArg, toReactive, arguments)
  },

  findIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findIndex', fn, thisArg, undefined, arguments)
  },

  findLast(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findLast', fn, thisArg, toReactive, arguments)
  },

  findLastIndex(
    fn: (item: unknown, index: number, array: unknown[]) => boolean,
    thisArg?: unknown,
  ) {
    return apply(this, 'findLastIndex', fn, thisArg, undefined, arguments)
  },

  // flat, flatMap could benefit from ARRAY_ITERATE but are not straight-forward to implement

  forEach(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'forEach', fn, thisArg, undefined, arguments)
  },

  includes(...args: unknown[]) {
    return searchProxy(this, 'includes', args)
  },

  indexOf(...args: unknown[]) {
    return searchProxy(this, 'indexOf', args)
  },

  join(separator?: string) {
    return reactiveReadArray(this).join(separator)
  },

  // keys() iterator only reads `length`, no optimisation required

  lastIndexOf(...args: unknown[]) {
    return searchProxy(this, 'lastIndexOf', args)
  },

  map(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'map', fn, thisArg, undefined, arguments)
  },

  pop() {
    return noTracking(this, 'pop')
  },

  push(...args: unknown[]) {
    return noTracking(this, 'push', args)
  },

  reduce(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    return reduce(this, 'reduce', fn, args)
  },

  reduceRight(
    fn: (
      acc: unknown,
      item: unknown,
      index: number,
      array: unknown[],
    ) => unknown,
    ...args: unknown[]
  ) {
    return reduce(this, 'reduceRight', fn, args)
  },

  shift() {
    return noTracking(this, 'shift')
  },

  // slice could use ARRAY_ITERATE but also seems to beg for range tracking

  some(
    fn: (item: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return apply(this, 'some', fn, thisArg, undefined, arguments)
  },

  splice(...args: unknown[]) {
    return noTracking(this, 'splice', args)
  },

  toReversed() {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toReversed()
  },

  toSorted(comparer?: (a: unknown, b: unknown) => number) {
    // @ts-expect-error user code may run in es2016+
    return reactiveReadArray(this).toSorted(comparer)
  },

  toSpliced(...args: unknown[]) {
    // @ts-expect-error user code may run in es2016+
    return (reactiveReadArray(this).toSpliced as any)(...args)
  },

  unshift(...args: unknown[]) {
    return noTracking(this, 'unshift', args)
  },

  values() {
    return iterator(this, 'values', toReactive)
  },
}

// instrument iterators to take ARRAY_ITERATE dependency
function iterator(
  self: unknown[],
  method: keyof Array<unknown>,
  wrapValue: (value: any) => unknown,
) {
  // note that taking ARRAY_ITERATE dependency here is not strictly equivalent
  // to calling iterate on the proxified array.
  // creating the iterator does not access any array property:
  // it is only when .next() is called that length and indexes are accessed.
  // pushed to the extreme, an iterator could be created in one effect scope,
  // partially iterated in another, then iterated more in yet another.
  // given that JS iterator can only be read once, this doesn't seem like
  // a plausible use-case, so this tracking simplification seems ok.
  // 注意这里获取 ARRAY_ITERATE 依赖并不完全等同于在代理数组上调用 iterate
  // 创建迭代器时不会访问任何数组属性:
  // 只有在调用 .next() 时才会访问 length 和 indexes索引
  // 在极端情况下,一个迭代器可能在一个 effect 作用域中创建,
  // 在另一个作用域中部分迭代,然后在另一个作用域中继续迭代
  // 考虑到 JS 迭代器只能读取一次,这似乎不是一个合理的用例,
  // 所以这种追踪的简化方式看起来是可以接受的
  const arr = shallowReadArray(self) // 此时arr对应原数组
  // 获取原始数组上的【迭代器】对象
  const iter = (arr[method] as any)() as IterableIterator<unknown> & {
    _next: IterableIterator<unknown>['next']
  }
  // self一般对应数组的代理对象 arr对应原数组
  if (arr !== self && !isShallow(self)) {
    iter._next = iter.next
    // 封装原迭代器next方法，迭代返回的索引元素值是对象的话转换为响应式对象（即reactive处理）
    iter.next = () => {
      const result = iter._next() // 获取当前迭代索引对应的值（原迭代器方法）
      if (result.value) {
        // TODO:
        // 如果迭代元素是对象，那么转换为响应式对象（wrapValue对应toReactive对应reactive）
        // 遍历到哪些元素就转换哪些元素，lazy模式
        result.value = wrapValue(result.value)
      }
      return result
    }
  }
  return iter
}

// in the codebase we enforce es2016, but user code may run in environments
// higher than that
type ArrayMethods = keyof Array<any> | 'findLast' | 'findLastIndex'

const arrayProto = Array.prototype
// instrument functions that read (potentially) all items
// to take ARRAY_ITERATE dependency
function apply(
  self: unknown[],
  method: ArrayMethods,
  fn: (item: unknown, index: number, array: unknown[]) => unknown,
  thisArg?: unknown,
  wrappedRetFn?: (result: any) => unknown,
  args?: IArguments,
) {
  const arr = shallowReadArray(self)
  const needsWrap = arr !== self && !isShallow(self)
  // @ts-expect-error our code is limited to es2016 but user code is not
  const methodFn = arr[method]

  // #11759
  // If the method being called is from a user-extended Array, the arguments will be unknown
  // (unknown order and unknown parameter types). In this case, we skip the shallowReadArray
  // handling and directly call apply with self.
  if (methodFn !== arrayProto[method as any]) {
    const result = methodFn.apply(self, args)
    return needsWrap ? toReactive(result) : result
  }

  let wrappedFn = fn
  if (arr !== self) {
    if (needsWrap) {
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, toReactive(item), index, self)
      }
    } else if (fn.length > 2) {
      wrappedFn = function (this: unknown, item, index) {
        return fn.call(this, item, index, self)
      }
    }
  }
  const result = methodFn.call(arr, wrappedFn, thisArg)
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result
}

// instrument reduce and reduceRight to take ARRAY_ITERATE dependency
function reduce(
  self: unknown[],
  method: keyof Array<any>,
  fn: (acc: unknown, item: unknown, index: number, array: unknown[]) => unknown,
  args: unknown[],
) {
  const arr = shallowReadArray(self)
  let wrappedFn = fn
  if (arr !== self) {
    if (!isShallow(self)) {
      wrappedFn = function (this: unknown, acc, item, index) {
        return fn.call(this, acc, toReactive(item), index, self)
      }
    } else if (fn.length > 3) {
      wrappedFn = function (this: unknown, acc, item, index) {
        return fn.call(this, acc, item, index, self)
      }
    }
  }
  return (arr[method] as any)(wrappedFn, ...args)
}

// instrument identity-sensitive methods to account for reactive proxies
function searchProxy(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[],
) {
  const arr = toRaw(self) as any
  track(arr, TrackOpTypes.ITERATE, ARRAY_ITERATE_KEY)
  // we run the method using the original args first (which may be reactive)
  const res = arr[method](...args)

  // if that didn't work, run it again using raw values.
  if ((res === -1 || res === false) && isProxy(args[0])) {
    args[0] = toRaw(args[0])
    return arr[method](...args)
  }

  return res
}

// instrument length-altering mutation methods to avoid length being tracked
// which leads to infinite loops in some cases (#2137)
// 对会改变数组长度的变异方法进行处理,避免追踪length属性
// 因为在某些情况下会导致无限循环 (#2137)
function noTracking(
  self: unknown[],
  method: keyof Array<any>,
  args: unknown[] = [],
) {
  pauseTracking() // 暂时暂停effect的追踪，shouldTrack = false
  startBatch()
  const res = (toRaw(self) as any)[method].apply(self, args) // 注意这里传入apply方法的self还是数组代理对象
  endBatch()
  resetTracking()
  return res
}
