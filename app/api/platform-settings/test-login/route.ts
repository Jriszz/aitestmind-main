import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { insecureRequest } from '@/lib/insecure-fetch';

// 测试登录接口并获取Session
export async function POST() {
  try {
    // 获取当前的平台设置
    const settings = await prisma.platformSettings.findFirst({
      orderBy: {
        updatedAt: 'desc',
      },
    });

    if (!settings || !settings.sessionEnabled || !settings.loginApiUrl) {
      return NextResponse.json(
        {
          success: false,
          error: '未配置登录接口或Session模式未启用',
        },
        { status: 400 }
      );
    }

    // 构建登录请求
    const loginHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // 添加自定义请求头
    if (settings.loginRequestHeaders && typeof settings.loginRequestHeaders === 'object') {
      Object.assign(loginHeaders, settings.loginRequestHeaders);
    }

    // 规范化登录 URL：去空格、补协议
    let loginUrl = (settings.loginApiUrl || '').trim();
    if (!/^https?:\/\//i.test(loginUrl)) {
      loginUrl = `https://${loginUrl}`;
    }

    // 发送登录请求
    console.log('[测试登录] 发送请求:', {
      url: loginUrl,
      method: settings.loginMethod,
      headers: loginHeaders,
      body: settings.loginRequestBody,
    });

    // 用 insecureRequest：跳过自签名/内网证书校验，行为对齐执行器 httpx(verify=False)
    const response = await insecureRequest(loginUrl, {
      method: settings.loginMethod || 'POST',
      headers: loginHeaders,
      body: settings.loginRequestBody ? JSON.stringify(settings.loginRequestBody) : undefined,
    });

    console.log('[测试登录] 响应状态:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = response.text;
      console.log('[测试登录] 错误响应:', errorText);
      return NextResponse.json(
        {
          success: false,
          error: `登录失败: ${response.status} ${response.statusText}`,
        },
        { status: response.status }
      );
    }

    // 读取响应数据（用于日志）
    const responseText = response.text;
    let responseData: any = null;
    
    try {
      responseData = JSON.parse(responseText);
      console.log('[测试登录] 响应数据:', responseData);
    } catch (e) {
      console.log('[测试登录] 响应不是JSON格式:', responseText.substring(0, 200));
    }

    // 自动提取所有Set-Cookie响应头（类似requests.Session()）
    const setCookieHeaders = response.setCookieHeaders;
    console.log('[测试登录] Set-Cookie响应头数量:', setCookieHeaders.length);
    console.log('[测试登录] Set-Cookie详情:', setCookieHeaders);

    // 解析所有cookies，提取名称=值部分
    const cookiePairs: string[] = [];
    
    for (const setCookie of setCookieHeaders) {
      // 提取cookie的 name=value 部分（忽略其他属性如Path, HttpOnly等）
      const match = setCookie.match(/^([^=]+)=([^;]+)/);
      if (match) {
        const cookieName = match[1].trim();
        const cookieValue = match[2].trim();
        cookiePairs.push(`${cookieName}=${cookieValue}`);
        console.log(`[测试登录] 提取Cookie: ${cookieName}=${cookieValue}`);
      }
    }

    // 将所有cookies合并成Cookie头格式：cookie1=value1; cookie2=value2
    const allCookies = cookiePairs.join('; ');
    console.log('[测试登录] 合并后的Cookies:', allCookies);

    // 更新平台设置中的Session信息
    if (allCookies) {
      await prisma.platformSettings.update({
        where: {
          id: settings.id,
        },
        data: {
          sessionCookies: allCookies,
          sessionUpdatedAt: new Date(),
        },
      });

      return NextResponse.json({
        success: true,
        data: {
          cookieCount: cookiePairs.length,
          cookies: cookiePairs,
          loginTime: new Date().toISOString(),
        },
        message: `Session获取成功，共保存${cookiePairs.length}个Cookie`,
      });
    } else {
      // 没有Set-Cookie响应头
      const debugInfo = {
        setCookieHeadersCount: setCookieHeaders.length,
        responseStatus: response.status,
        responseHeaders: response.headers,
        responseDataSample: responseText.substring(0, 500),
        hint: '登录接口没有返回Set-Cookie响应头。请检查：1) 登录接口是否配置正确 2) 登录凭据是否正确 3) 该接口是否真的返回cookies',
      };

      console.log('[测试登录] 未找到Set-Cookie，调试信息:', debugInfo);

      return NextResponse.json(
        {
          success: false,
          error: '登录接口没有返回任何Cookie',
          debug: debugInfo,
        },
        { status: 400 }
      );
    }
  } catch (error) {
    // undici 把真实网络原因藏在 error.cause 里，外层只显示 "fetch failed"
    const cause = (error as any)?.cause;
    console.error('Error testing login:', error);
    if (cause) {
      console.error('Error testing login [cause]:', cause);
    }
    const detail =
      cause?.code || cause?.message
        ? `${error instanceof Error ? error.message : String(error)} (${cause.code || cause.message})`
        : error instanceof Error
          ? error.message
          : String(error);
    return NextResponse.json(
      {
        success: false,
        error: `测试登录失败: ${detail}`,
      },
      { status: 500 }
    );
  }
}

