import { isRef, ref } from '../src/ref'
import {
  isProxy,
  isReactive,
  isReadonly,
  isShallow,
  markRaw,
  reactive,
  readonly,
  shallowReactive,
  shallowReadonly,
  toRaw,
} from '../src/reactive'
import { computed } from '../src/computed'
import { effect } from '../src/effect'
import { targetMap } from '../src/dep'

describe('reactivity/reactive', () => {
  test('Object', () => {
    const original = { foo: 1 }
    const observed = reactive(original)
    expect(observed).not.toBe(original)
    expect(isReactive(observed)).toBe(true)
    expect(isReactive(original)).toBe(false)
    // get
    expect(observed.foo).toBe(1)
    // has
    expect('foo' in observed).toBe(true)
    // ownKeys
    // observed如果是数组那么track key = 'length'，这里是对象track ITERATE_KEY
    expect(Object.keys(observed)).toEqual(['foo'])
  })

  test('proto', () => {
    const obj = {}
    const reactiveObj = reactive(obj)
    expect(isReactive(reactiveObj)).toBe(true)
    // read prop of reactiveObject will cause reactiveObj[prop] to be reactive
    // @ts-expect-error
    // 访问原型会直接返回，不会收集依赖
    const prototype = reactiveObj['__proto__']
    const otherObj = { data: ['a'] }
    expect(isReactive(otherObj)).toBe(false)
    const reactiveOther = reactive(otherObj)
    expect(isReactive(reactiveOther)).toBe(true)
    // 上一步访问定义reactive(otherObj)时，内部.data对应的数组还没被包装成代理
    // 因为是lazy模式加载的，下面访问reactiveOther.data的时候，先收集依赖，
    // 然后因为值是对象，所以如果proxyMap中没有这个对象关联的proxy，那么创建proxy并返回
    // 接着访问reactiveOther.data[0]的时候，会触发proxy的get拦截，然后触发依赖收集，收集到[reactiveOther.data, 0]dep中
    expect(reactiveOther.data[0]).toBe('a')
  })

  test('nested reactives', () => {
    const original = {
      nested: {
        foo: 1,
      },
      array: [{ bar: 2 }],
    }
    const observed = reactive(original)
    expect(isReactive(observed.nested)).toBe(true)
    expect(isReactive(observed.array)).toBe(true)
    // [observed, array] & [observed.array, 0]都是代理
    // 内部嵌套的合法对象（非冻结，非只读），访问时都会把原对象转换为代理，然后再进一步访问，此时刚转换的代理也能收集到依赖
    expect(isReactive(observed.array[0])).toBe(true)
  })

  test('observing subtypes of IterableCollections(Map, Set)', () => {
    // subtypes of Map
    class CustomMap extends Map {}
    // Object.prototype.toString.call(new CustomMap()) -> [object Map]
    const cmap = reactive(new CustomMap())

    expect(cmap).toBeInstanceOf(Map)
    expect(isReactive(cmap)).toBe(true)

    // trigger [toRaw(cmap), 'key']（但是实际没有，因为都没有收集依赖，所以targetMap中没记录）
    cmap.set('key', {})
    // track [cmap, 'key']，依赖收集，返回{}的代理对象（被reactive包裹）
    expect(isReactive(cmap.get('key'))).toBe(true)

    // subtypes of Set
    // Set也是同理，因为对应的代理handler都是mutableCollectionHandlers
    class CustomSet extends Set {}
    const cset = reactive(new CustomSet())

    expect(cset).toBeInstanceOf(Set)
    expect(isReactive(cset)).toBe(true)

    let dummy
    // 会先触发 track [cset, 'value']，依赖收集，然后才是真正调用cset.has('value')，返回false
    effect(() => (dummy = cset.has('value')))
    expect(dummy).toBe(false)
    cset.add('value') // trigger
    expect(dummy).toBe(true)
    cset.delete('value')
    expect(dummy).toBe(false)
  })

  // 同理（类似Map/Set）
  test('observing subtypes of WeakCollections(WeakMap, WeakSet)', () => {
    // subtypes of WeakMap
    class CustomMap extends WeakMap {}
    const cmap = reactive(new CustomMap())

    expect(cmap).toBeInstanceOf(WeakMap)
    expect(isReactive(cmap)).toBe(true)

    const key = {}
    cmap.set(key, {})
    expect(isReactive(cmap.get(key))).toBe(true)

    // subtypes of WeakSet
    class CustomSet extends WeakSet {}
    const cset = reactive(new CustomSet())

    expect(cset).toBeInstanceOf(WeakSet)
    expect(isReactive(cset)).toBe(true)

    let dummy
    effect(() => (dummy = cset.has(key)))
    expect(dummy).toBe(false)
    cset.add(key)
    expect(dummy).toBe(true)
    cset.delete(key)
    expect(dummy).toBe(false)
  })

  test('observed value should proxy mutations to original (Object)', () => {
    const original: any = { foo: 1 }
    const observed = reactive(original)
    // set
    observed.bar = 1 // trigger and Reflect.set实际设置值
    expect(observed.bar).toBe(1)
    expect(original.bar).toBe(1)
    // delete
    // 触发 handler.deleteProperty
    // 触发 trigger [toRaw(observed), 'foo']
    // 触发 track [toRaw(observed), ITERATE_KEY]（ITERATE_KEY是对象迭代过程中负责收集依赖的key）
    delete observed.foo
    expect('foo' in observed).toBe(false) // 触发 handler.has track
    expect('foo' in original).toBe(false) // 触发 handler.has track
  })

  test('original value change should reflect in observed value (Object)', () => {
    const original: any = { foo: 1 }
    const observed = reactive(original)
    // set
    original.bar = 1
    expect(original.bar).toBe(1)
    // track [original, 'bar']，Reflect.get从原对象上获取值
    // 但是因为上面是直接在原对象上设置值，所以不会被代理拦截器拦截到设置值，所以不会触发trigger
    expect(observed.bar).toBe(1)
    // delete
    delete original.foo // 同理，在原对象上增删值，不会被代理拦截，所以不会trigger
    expect('foo' in original).toBe(false)
    expect('foo' in observed).toBe(false) // track
  })

  test('setting a property with an unobserved value should wrap with reactive', () => {
    const observed = reactive<{ foo?: object }>({})
    const raw = {}
    observed.foo = raw // handler.set -> trigger(实际因为内部直接return) -> Reflect.set
    expect(observed.foo).not.toBe(raw) // 因为此时返回的是raw的代理对象
    expect(isReactive(observed.foo)).toBe(true) // Reflect.get获取原对象 -> track收集依赖 -> reactive(raw)
  })

  test('observing already observed value should return same Proxy', () => {
    const original = { foo: 1 }
    const observed = reactive(original)
    const observed2 = reactive(observed) // 通过ReactiveFlags.RAW和ReactiveFlags.IS_REACTIVE标识
    expect(observed2).toBe(observed)
  })

  test('observing the same value multiple times should return same Proxy', () => {
    const original = { foo: 1 }
    const observed = reactive(original)
    const observed2 = reactive(original) // 通过reactiveMap.get(target)全局获取已经创建的代理对象返回
    expect(observed2).toBe(observed)
  })

  test('should not pollute original object with Proxies', () => {
    const original: any = { foo: 1 }
    const original2 = { bar: 2 }
    const observed = reactive(original)
    const observed2 = reactive(original2)
    observed.bar = observed2 // Reflect.set(raw(observed), 'bar', raw(observed2))
    // Reflect.get(raw(observed), 'bar') -> 获得raw(observed2) -> reactive(raw(observed2)) -> reactiveMap.get(raw(observed2))
    expect(observed.bar).toBe(observed2) // 1
    expect(original.bar).toBe(original2) // 2
    // 总结：两个代理对象，一个作为另一个的嵌套属性，此时原对象结构是没有变化的，即代理维护的原对象上的结构全是raw的方式，即原对象结构，不会被污染，不会出现原对象树上出现某个属性是代理
    // 然后访问的时候分为两种方式，即上面的1&2
    // 1. 通过代理访问属性，通过Reflect.get获取raw(observed2)，然后触发track，接着返回reactive(raw(observed2))，最后因为已经创建过对应原对象的代理了，所以从reactiveMap.get(raw(observed2))获取把该对象代理返回
    // 2. 通过原对象访问属性，直接返回原对象

    // TODO:对象树没有被污染， 而且通过reactiveMap全局缓存，所以每个对象只会创建一次代理，本身代理访问对象类型的属性时就会把该对象用reactive包装后返回...
  })

  // #1246
  test('mutation on objects using reactive as prototype should not trigger', () => {
    const observed = reactive({ foo: 1 })
    const original = Object.create(observed)
    let dummy
    // 因为original原对象上没有foo属性，所以往原型上找，触发observed get（只是receiver指向original罢了）
    // track [raw(observed), foo]
    effect(() => (dummy = original.foo))
    expect(dummy).toBe(1)
    observed.foo = 2
    expect(dummy).toBe(2)

    // 因为original原对象上没有foo属性，首次设置属性的时候会触发原型代理对象上的set handler（当然实际还是Reflect.set还是会正确把属性设置到receiver（即original）上的）
    // 当然并不会触发trigger [raw(observed), foo]，因为条件target === toRaw(receiver)不成立
    original.foo = 3
    expect(dummy).toBe(2)
    original.foo = 4
    expect(dummy).toBe(2)
  })

  test('toRaw', () => {
    const original = { foo: 1 }
    const observed = reactive(original)
    // 递归取ReactiveFlags.RAW，直到取到原始对象，这里其实会触发observed get handler，对key为ReactiveFlags.RAW会做特殊处理
    expect(toRaw(observed)).toBe(original)
    expect(toRaw(original)).toBe(original)
  })

  test('toRaw on object using reactive as prototype', () => {
    const original = { foo: 1 }
    const observed = reactive(original)
    const inherted = Object.create(observed)
    // toRaw(inherted) -> 内部访问inherted[ReactiveFlags.RAW]，因为原对象上没有这个属性，所以去原型对象上找
    // 确实触发了observed get handler，但是getter中会判断receiver !== proxyMap(target)，所以不会返回target，而是返回undefined
    // 所以最终toRaw函数返回inherted本身
    expect(toRaw(inherted)).toBe(inherted)
  })

  test('toRaw on user Proxy wrapping reactive', () => {
    const original = {}
    const re = reactive(original)
    const obj = new Proxy(re, {})
    const raw = toRaw(obj)
    // 代理包代理的情况
    // Object.getPrototypeOf(<任意代理>)都是相同的
    // 而且每一层代理的get handler都会触发，所以最终拿到的是原始对象
    expect(raw).toBe(original)
  })

  test('should not unwrap Ref<T>', () => {
    // reactive代理中target是ref的情况
    const observedNumberRef = reactive(ref(1))
    const observedObjectRef = reactive(ref({ foo: 1 }))

    // isRef(observedNumberRef), 访问最外层代理的ReactiveFlags.IS_REF属性
    // 该属性key在外层代理geth（get handler简写）上没有特殊处理
    // 所以会实际触发Reflect.get(target（对应ref对象）, key（ReactiveFlags.IS_REF）, receiver（内部处理了，也对应ref对象）)
    // 因此最终访问的是ref对象上的ReactiveFlags.IS_REF属性，因此返回true
    // 注意：看源码，好像也会触发track [ref对象, ReactiveFlags.IS_REF]的依赖收集...
    expect(isRef(observedNumberRef)).toBe(true)
    expect(isRef(observedObjectRef)).toBe(true)
  })

  test('should unwrap computed refs', () => {
    // computed结构和ref返回差不多（类ref）
    // 因为isRef(a) = true
    // readonly
    const a = computed(() => 1)
    // writable
    const b = computed({
      get: () => 1,
      set: () => {},
    })
    const obj = reactive({ a, b })
    // check type
    // obj.a，会走 obj geth，对于Reflect.get返回值是ref的（即__v_isRef = true）对象（非数组），那么会自动解包
    // 所以不需要obj.a.value，直接obj.a即可获取到a.value，然后就走ref内部访问器方法
    // track [raw(obj), a]（对应weakMap<target, Map<key, Dep>>结构，即全局targetMap）
    // track [a, value]（当然这里其实对应的数据结构是ref实例对象，ref.dep）
    // 猜测：如果computed getter函数中有响应性变量，那这些变量既能收集到computed本身effect，也能收集到外层effect（就像vue2中computed属性的访问器一样，触发computedWatcher.evaluate和depend一样）
    obj.a + 1
    obj.b + 1
    expect(typeof obj.a).toBe(`number`)
    expect(typeof obj.b).toBe(`number`)
  })

  test('should allow setting property from a ref to another ref', () => {
    const foo = ref(0)
    const bar = ref(1)
    const observed = reactive({ a: foo })
    const dummy = computed(() => observed.a)
    // track [raw(observed), a]
    // track [foo, value]
    // 都能收集到computed effect?
    // 都能收集到外层effect?
    // 还是说vue3中的处理方式是computed对象本身去收集外层依赖，然后如果trigger[raw(observed), a]的时候会先触发computed effect，然后接着computed本身触发外层依赖？
    expect(dummy.value).toBe(0)

    // @ts-expect-error
    // trigger [raw(observed), a]，ref替换
    // computed effect 标识 computed dirty标识为true，外层effect执行？
    // 触发track [bar, value]，收集依赖
    // 那原依赖怎么卸载？？？（vue2是通过在watcher中记录新旧dep list&map，通过每次watcher.getter执行时重新收集依赖后续来进行的）
    observed.a = bar
    // computed effect是lazy的
    // 下面获取dummy.value，触发computed刷新值，真正track [bar, value]
    expect(dummy.value).toBe(1)

    bar.value++ // trigger [bar, value]，computed dirty
    expect(dummy.value).toBe(2)
  })

  test('non-observable values', () => {
    const assertValue = (value: any) => {
      reactive(value)
      expect(
        `value cannot be made reactive: ${String(value)}`,
      ).toHaveBeenWarnedLast()
    }

    // number
    assertValue(1)
    // string
    assertValue('foo')
    // boolean
    assertValue(false)
    // null
    assertValue(null)
    // undefined
    assertValue(undefined)
    // symbol
    const s = Symbol()
    assertValue(s)
    // bigint
    const bn = BigInt('9007199254740991')
    assertValue(bn)

    // built-ins should work and return same value
    // 内置对象，返回本身
    const p = Promise.resolve()
    expect(reactive(p)).toBe(p)
    const r = new RegExp('')
    expect(reactive(r)).toBe(r)
    const d = new Date()
    expect(reactive(d)).toBe(d)
  })

  test('markRaw', () => {
    const obj = reactive({
      foo: { a: 1 },
      // 对象定义ReactiveFlags.SKIP标识，所以我们访问obj.bar的时候，会直接返回bar原对象，而不是原对象的代理
      bar: markRaw({ b: 2 }),
    })
    expect(isReactive(obj.foo)).toBe(true)
    expect(isReactive(obj.bar)).toBe(false)
  })

  test('markRaw should skip non-extensible objects', () => {
    const obj = Object.seal({ foo: 1 })
    expect(() => markRaw(obj)).not.toThrowError()
  })

  test('markRaw should not redefine on an marked object', () => {
    const obj = markRaw({ foo: 1 })
    const raw = markRaw(obj)
    expect(raw).toBe(obj)
    expect(() => markRaw(obj)).not.toThrowError()
  })

  test('should not observe non-extensible objects', () => {
    const obj = reactive({
      foo: Object.preventExtensions({ a: 1 }),
      // sealed or frozen objects are considered non-extensible as well
      bar: Object.freeze({ a: 1 }),
      baz: Object.seal({ a: 1 }),
    })
    expect(isReactive(obj.foo)).toBe(false)
    expect(isReactive(obj.bar)).toBe(false)
    expect(isReactive(obj.baz)).toBe(false)
  })

  test('should not observe objects with __v_skip', () => {
    const original = {
      foo: 1,
      __v_skip: true,
    }
    const observed = reactive(original)
    expect(isReactive(observed)).toBe(false)
  })

  test('hasOwnProperty edge case: Symbol values', () => {
    const key = Symbol()
    const obj = reactive({ [key]: 1 }) as { [key]?: 1 }
    let dummy
    effect(() => {
      // obj handler.has -> track(obj, key)
      // 非内置Symbol，也会收集依赖
      dummy = obj.hasOwnProperty(key)
    })
    expect(dummy).toBe(true)

    delete obj[key] // Reflect.deleteProperty trigger
    expect(dummy).toBe(false)
  })

  test('hasOwnProperty edge case: non-string values', () => {
    const key = {}
    const obj = reactive({ '[object Object]': 1 }) as { '[object Object]'?: 1 }
    let dummy
    effect(() => {
      // @ts-expect-error
      dummy = obj.hasOwnProperty(key)
    })
    expect(dummy).toBe(true)

    // @ts-expect-error
    delete obj[key]
    expect(dummy).toBe(false)
  })

  test('isProxy', () => {
    const foo = {}
    expect(isProxy(foo)).toBe(false)

    const fooRe = reactive(foo)
    expect(isProxy(fooRe)).toBe(true)

    const fooSRe = shallowReactive(foo)
    expect(isProxy(fooSRe)).toBe(true)

    const barRl = readonly(foo)
    expect(isProxy(barRl)).toBe(true)

    const barSRl = shallowReadonly(foo)
    expect(isProxy(barSRl)).toBe(true)

    const c = computed(() => {})
    expect(isProxy(c)).toBe(false)
    // 补充
    expect(isRef(c)).toBe(true)
  })

  test('The results of the shallow and readonly assignments are the same (Map)', () => {
    const map = reactive(new Map()) // 代理对应的mutableCollectionHandlers
    map.set('foo', shallowReactive({ a: 2 })) // trigger [raw(map), 'foo']
    // 判断ReactiveFlags.IS_SHALLOW]标识，代理内部get handler会特殊处理
    // track [raw(map), 'foo']
    // Reflect.get返回值isReactive了，所以不会再主动转换为代理对象
    expect(isShallow(map.get('foo'))).toBe(true)

    map.set('bar', readonly({ b: 2 })) // trigger [raw(map), 'bar']
    // 同理，只不过这次代理对象的handler是readonlyHandlers
    expect(isReadonly(map.get('bar'))).toBe(true)
  })

  test('The results of the shallow and readonly assignments are the same (Set)', () => {
    const set = reactive(new Set())
    // trigger [raw(set), shallowReactive({ a: 2 })]
    set.add(shallowReactive({ a: 2 }))
    // trigger [raw(set), readonly({ b: 2 })]
    set.add(readonly({ b: 2 }))
    let count = 0
    // track [raw(set), ITERATE_KEY]
    // 代理内部覆写迭代器next方法，每次迭代的值都会被转换为代理（toReactive/toReadonly/toShallow）
    // 内部会调用set[Symbol.iterator]方法
    for (const i of set) {
      if (count === 0) expect(isShallow(i)).toBe(true)
      else expect(isReadonly(i)).toBe(true)
      count++
    }
  })

  // #11696
  test('should use correct receiver on set handler for refs', () => {
    const a = reactive(ref(1))
    // Reflect.get(target(ref(1)), key(value), receiver(ref(1))
    // track [ref(1), value]
    // track [raw(a)（其实就是ref（1））, value]
    // 上两者track的区别：依赖收集存储的地方不同，前者是ref.dep，后者是targetMap
    effect(() => a.value)
    expect(() => {
      // trigger [ref(1), value]
      // trigger [raw(a)（ref（1））, value]
      // 都是触发同一个effect，所以这里应该是有批处理的
      a.value++
    }).not.toThrow()
  })

  // #11979
  test('should release property Dep instance if it no longer has subscribers', () => {
    let obj = { x: 1 }
    let a = reactive(obj)
    // track [obj, x] -> targetMap(obj) -> Map<x, Dep> -> Dep收集effect依赖，effect.deps.push(Dep)？
    const e = effect(() => a.x)
    expect(targetMap.get(obj)?.get('x')).toBeTruthy()
    // effect.stop() -> effect.deps.forEach(dep => dep.delete(effect)) ???
    e.effect.stop()
    // 停止后，targetMap中对应的依赖被删除，所以此时空Dep？
    expect(targetMap.get(obj)?.get('x')).toBeFalsy()
  })

  test('should trigger reactivity when Map key is undefined', () => {
    const map = reactive(new Map())
    const c = computed(() => map.get(void 0))

    // computed effect执行
    // track [raw(map), void 0]
    // raw(map).get(void 0) -> 返回void 0
    // computed内部缓存gettter计算结果值并返回
    expect(c.value).toBe(void 0)

    // trigger [raw(map), void 0] 触发computed effect
    // computed标记为dirty，缓存失效？
    map.set(void 0, 1)
    expect(c.value).toBe(1)
  })
})
