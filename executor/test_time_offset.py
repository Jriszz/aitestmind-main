#!/usr/bin/env python3
"""
测试时间函数的偏移量功能
"""

from runtime_functions import resolve_runtime_functions
from datetime import datetime, timedelta


def test_timestamp_offset():
    """测试 timestamp 偏移量"""
    print("=" * 60)
    print("测试 timestamp 偏移量")
    print("=" * 60)

    # 当前时间戳
    result = resolve_runtime_functions("${{timestamp()}}")
    print(f"当前时间戳: {result}")

    # 明天此刻
    result = resolve_runtime_functions("${{timestamp(days=1)}}")
    expected = int((datetime.now() + timedelta(days=1)).timestamp())
    print(f"明天此刻: {result} (预期约 {expected})")

    # 7天前
    result = resolve_runtime_functions("${{timestamp(days=-7)}}")
    expected = int((datetime.now() + timedelta(days=-7)).timestamp())
    print(f"7天前: {result} (预期约 {expected})")

    # 1小时后
    result = resolve_runtime_functions("${{timestamp(hours=1)}}")
    print(f"1小时后: {result}")

    # 组合偏移：明天+2小时
    result = resolve_runtime_functions("${{timestamp(days=1, hours=2)}}")
    print(f"明天+2小时: {result}")
    print()


def test_datetime_offset():
    """测试 datetime 偏移量"""
    print("=" * 60)
    print("测试 datetime 偏移量")
    print("=" * 60)

    # 当前时间
    result = resolve_runtime_functions('${{datetime("YYYY-MM-DD HH:mm:ss")}}')
    print(f"当前时间: {result}")

    # 7天前的日期
    result = resolve_runtime_functions('${{datetime("YYYY-MM-DD", days=-7)}}')
    expected = (datetime.now() + timedelta(days=-7)).strftime("%Y-%m-%d")
    print(f"7天前的日期: {result} (预期 {expected})")

    # 明天+2小时
    result = resolve_runtime_functions('${{datetime("YYYY-MM-DD HH:mm:ss", days=1, hours=2)}}')
    print(f"明天+2小时: {result}")

    # 30分钟前
    result = resolve_runtime_functions('${{datetime("HH:mm:ss", minutes=-30)}}')
    print(f"30分钟前: {result}")
    print()


def test_date_offset():
    """测试 date 偏移量"""
    print("=" * 60)
    print("测试 date 偏移量")
    print("=" * 60)

    # 今天
    result = resolve_runtime_functions('${{date()}}')
    print(f"今天: {result}")

    # 30天后
    result = resolve_runtime_functions('${{date(days=30)}}')
    expected = (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d")
    print(f"30天后: {result} (预期 {expected})")

    # 昨天
    result = resolve_runtime_functions('${{date(days=-1)}}')
    expected = (datetime.now() + timedelta(days=-1)).strftime("%Y-%m-%d")
    print(f"昨天: {result} (预期 {expected})")
    print()


def test_time_offset():
    """测试 time 偏移量"""
    print("=" * 60)
    print("测试 time 偏移量")
    print("=" * 60)

    # 当前时间
    result = resolve_runtime_functions('${{time()}}')
    print(f"当前时间: {result}")

    # 2小时后
    result = resolve_runtime_functions('${{time(hours=2)}}')
    print(f"2小时后: {result}")

    # 30分钟前
    result = resolve_runtime_functions('${{time(minutes=-30)}}')
    print(f"30分钟前: {result}")

    # 组合：1小时后+15分钟
    result = resolve_runtime_functions('${{time(hours=1, minutes=15)}}')
    print(f"1小时15分钟后: {result}")
    print()


def test_string_concat():
    """测试字符串拼接中的偏移量"""
    print("=" * 60)
    print("测试字符串拼接中的偏移量")
    print("=" * 60)

    result = resolve_runtime_functions('订单_${{timestamp(days=1)}}_${{random(4)}}')
    print(f"订单号（明天）: {result}")

    result = resolve_runtime_functions('查询_${{date(days=-7)}}_到_${{date()}}')
    print(f"日期区间: {result}")
    print()


if __name__ == "__main__":
    test_timestamp_offset()
    test_datetime_offset()
    test_date_offset()
    test_time_offset()
    test_string_concat()

    print("=" * 60)
    print("[OK] 所有测试完成！")
    print("=" * 60)
