"""
测试新增的断言操作符（P0 + P1）和 ExpectedType.DECIMAL。

P0：notEmpty / in / notIn / decimal 精确比较
P1：lengthEquals / lengthGreaterThan / lengthLessThan / eachEquals / eachMatches

运行：python -m pytest executor/test_assertion_new_operators.py -v
或：cd executor && python test_assertion_new_operators.py
"""
from decimal import Decimal

from variable_manager import VariableManager
from assertion_engine import AssertionEngine
from models import Assertion, AssertionOperator, ExpectedType


def _engine():
    return AssertionEngine(VariableManager())


def _run(engine: AssertionEngine, field: str, operator: AssertionOperator,
         expected, response, expected_type: ExpectedType = ExpectedType.AUTO):
    asn = Assertion(field=field, operator=operator, expected=expected, expectedType=expected_type)
    return engine.execute_assertion(asn, response)


# ============== P0: notEmpty（柜台流水号场景） ==============

def test_not_empty_rejects_empty_string():
    """exists 对空串放水的修复：notEmpty 拒绝空串（流水号事故源头）"""
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'traceNo': ''}}
    r = _run(eng, 'traceNo', AssertionOperator.NOT_EMPTY, None, resp)
    assert r.success is False, f"空串必须断言失败，实际: {r.success}"


def test_not_empty_rejects_none():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'traceNo': None}}
    r = _run(eng, 'traceNo', AssertionOperator.NOT_EMPTY, None, resp)
    assert r.success is False


def test_not_empty_rejects_empty_list_and_dict():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'list': [], 'obj': {}}}
    assert _run(eng, 'list', AssertionOperator.NOT_EMPTY, None, resp).success is False
    assert _run(eng, 'obj', AssertionOperator.NOT_EMPTY, None, resp).success is False


def test_not_empty_passes_real_value():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'traceNo': '20260630000001'}}
    r = _run(eng, 'traceNo', AssertionOperator.NOT_EMPTY, None, resp)
    assert r.success is True


# ============== P0: in / notIn（柜台业务码枚举） ==============

def test_in_with_array_expected():
    """业务码 ∈ {0, 1001, 1002} 都算受理成功"""
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'returnCode': 1001}}
    r = _run(eng, 'returnCode', AssertionOperator.IN, [0, 1001, 1002], resp)
    assert r.success is True


def test_in_with_json_string_expected():
    """期望值是 JSON 字符串也要能解析"""
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'returnCode': 0}}
    r = _run(eng, 'returnCode', AssertionOperator.IN, '[0, 1001, 1002]', resp)
    assert r.success is True


def test_in_fails_when_not_in():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'returnCode': 9999}}
    r = _run(eng, 'returnCode', AssertionOperator.IN, [0, 1001, 1002], resp)
    assert r.success is False


def test_not_in_blacklist():
    """禁止集合：致命错误码不能出现"""
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'returnCode': 0}}
    r = _run(eng, 'returnCode', AssertionOperator.NOT_IN, [9999, -1], resp)
    assert r.success is True


# ============== P0: Decimal 精确比较（金额防线） ==============

def test_decimal_equals_avoids_float_precision_loss():
    """0.1 + 0.2 经典问题：在 Decimal 路径下必须精确等于 "0.30" """
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'amount': '0.30'}}
    r = _run(eng, 'amount', AssertionOperator.EQUALS, '0.30', resp, ExpectedType.DECIMAL)
    assert r.success is True
    assert isinstance(r.expected, Decimal)


def test_decimal_greater_than():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'fee': '100.01'}}
    r = _run(eng, 'fee', AssertionOperator.GREATER_THAN, '100.00', resp, ExpectedType.DECIMAL)
    assert r.success is True


def test_decimal_not_confused_by_float_repr():
    """字符串 "100.10" 在 Decimal 下严格等于 Decimal('100.10')，不会变成 100.0999..."""
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'amount': '100.10'}}
    r = _run(eng, 'amount', AssertionOperator.EQUALS, '100.10', resp, ExpectedType.DECIMAL)
    assert r.success is True


# ============== P1: length_* （分页/明细笔数） ==============

def test_length_equals_on_list():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'list': [1, 2, 3, 4, 5]}}
    r = _run(eng, 'list', AssertionOperator.LENGTH_EQUALS, 5, resp)
    assert r.success is True


def test_length_equals_fail():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'list': [1, 2, 3]}}
    r = _run(eng, 'list', AssertionOperator.LENGTH_EQUALS, 5, resp)
    assert r.success is False
    assert '5' in r.message and '3' in r.message


def test_length_greater_than():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'list': [1, 2, 3]}}
    r = _run(eng, 'list', AssertionOperator.LENGTH_GREATER_THAN, 0, resp)
    assert r.success is True


def test_length_less_than():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'list': [1, 2]}}
    r = _run(eng, 'list', AssertionOperator.LENGTH_LESS_THAN, 10, resp)
    assert r.success is True


def test_length_on_unsupported_type_fails_clearly():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'count': 42}}
    r = _run(eng, 'count', AssertionOperator.LENGTH_EQUALS, 2, resp)
    assert r.success is False
    assert '不支持取长度' in r.message


# ============== P1: each_equals（明细归属一致性） ==============

def test_each_equals_all_match():
    """查询账户 6217xxx 的明细 → 每条 accountNo 都必须是 6217xxx"""
    eng = _engine()
    resp = {
        'status': 200, 'headers': {},
        'body': {'list': ['6217001', '6217001', '6217001']}
    }
    r = _run(eng, 'list', AssertionOperator.EACH_EQUALS, ['6217001'], resp)
    assert r.success is True


def test_each_equals_detects_intruder():
    """有一条记录不属于本账户 = 越权 = 必须捕获"""
    eng = _engine()
    resp = {
        'status': 200, 'headers': {},
        'body': {'list': ['6217001', '6217001', '6217999']}
    }
    r = _run(eng, 'list', AssertionOperator.EACH_EQUALS, ['6217001'], resp)
    assert r.success is False
    assert '6217999' in r.message
    assert '[2]' in r.message  # 第 2 项（0-indexed）


def test_each_equals_empty_list_fails():
    """空列表无可证伪——但柜台语境下 "造数据后查询" 期望非空，故判失败"""
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'list': []}}
    r = _run(eng, 'list', AssertionOperator.EACH_EQUALS, ['6217001'], resp)
    assert r.success is False
    assert '空' in r.message


def test_each_equals_accepts_multiple_allowed_values():
    """每一项 ∈ {Active, Suspended} 都算合规"""
    eng = _engine()
    resp = {
        'status': 200, 'headers': {},
        'body': {'list': ['Active', 'Suspended', 'Active']}
    }
    r = _run(eng, 'list', AssertionOperator.EACH_EQUALS, ['Active', 'Suspended'], resp)
    assert r.success is True


# ============== P1: each_matches（流水号格式批量校验） ==============

def test_each_matches_pattern():
    """所有流水号必须 18 位数字"""
    eng = _engine()
    resp = {
        'status': 200, 'headers': {},
        'body': {'list': ['202606300000000001', '202606300000000002', '202606300000000003']}
    }
    r = _run(eng, 'list', AssertionOperator.EACH_MATCHES, r'^\d{18}$', resp)
    assert r.success is True


def test_each_matches_catches_invalid():
    eng = _engine()
    resp = {
        'status': 200, 'headers': {},
        'body': {'list': ['202606300000000001', 'INVALID', '202606300000000003']}
    }
    r = _run(eng, 'list', AssertionOperator.EACH_MATCHES, r'^\d{18}$', resp)
    assert r.success is False
    assert 'INVALID' in r.message


# ============== 向后兼容：原 8 个算子语义不动 ==============

def test_exists_still_passes_on_empty_string():
    """决策 13 红线：exists 不动语义；"非空" 要用 notEmpty 显式表达"""
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'traceNo': ''}}
    r = _run(eng, 'traceNo', AssertionOperator.EXISTS, None, resp)
    assert r.success is True, "exists 必须保持向后兼容（空串依然算存在）"


def test_existing_greater_than_still_works_with_numbers():
    eng = _engine()
    resp = {'status': 200, 'headers': {}, 'body': {'count': 10}}
    r = _run(eng, 'count', AssertionOperator.GREATER_THAN, 5, resp)
    assert r.success is True


if __name__ == '__main__':
    # 简易直跑模式（不依赖 pytest）
    import sys
    import traceback

    tests = [(name, fn) for name, fn in globals().items()
             if name.startswith('test_') and callable(fn)]

    passed = failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {name}: {e}")
            failed += 1
        except Exception:
            print(f"  ERROR {name}")
            traceback.print_exc()
            failed += 1

    print(f"\n总计: {passed} 通过 / {failed} 失败 / {len(tests)} 用例")
    sys.exit(0 if failed == 0 else 1)
