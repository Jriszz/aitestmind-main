/**
 * 工作区回填脚本（资产管理总线 Step 1）
 *
 * 作用：
 * 1. 创建/获取默认工作区（slug='default', isDefault=true）
 * 2. 将所有缺 workspaceId 的资产（Api/TestCase/TestSuite/InterfaceFunctionalCase/Conversation）回填到默认工作区
 * 3. 将所有缺 currentWorkspaceId 的用户回填到默认工作区
 *
 * 幂等：可重复运行，第二次运行所有计数为 0。
 *
 * 运行方式：node scripts/backfill-workspace.js
 * 升级流程：拉代码 → npx prisma db push → node scripts/backfill-workspace.js → 重启 dev
 *
 * 详见 docs/DESIGN_DECISIONS.md 决策 10。
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function backfillWorkspace() {
  console.log('🚀 开始回填工作区...\n');

  // 1. 创建/获取默认工作区
  const def = await prisma.workspace.upsert({
    where: { slug: 'default' },
    update: {},
    create: {
      name: '默认工作区',
      slug: 'default',
      description: '系统默认工作区，迁移自单空间历史数据',
      isDefault: true,
    },
  });
  console.log(`✅ 默认工作区已就绪：${def.name} (id=${def.id})\n`);

  // 2. 回填资产表
  const tables = [
    { name: 'Api', model: prisma.api },
    { name: 'TestCase', model: prisma.testCase },
    { name: 'TestSuite', model: prisma.testSuite },
    { name: 'InterfaceFunctionalCase', model: prisma.interfaceFunctionalCase },
    { name: 'Conversation', model: prisma.conversation },
  ];

  for (const { name, model } of tables) {
    const result = await model.updateMany({
      where: { workspaceId: null },
      data: { workspaceId: def.id },
    });
    console.log(`  ${name.padEnd(28)} 回填 ${result.count} 行`);
  }

  // 3. 回填用户 currentWorkspaceId
  const userResult = await prisma.user.updateMany({
    where: { currentWorkspaceId: null },
    data: { currentWorkspaceId: def.id },
  });
  console.log(`  ${'User.currentWorkspaceId'.padEnd(28)} 回填 ${userResult.count} 行`);

  console.log('\n🎉 回填完成。');
}

backfillWorkspace()
  .catch((e) => {
    console.error('❌ 回填失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
