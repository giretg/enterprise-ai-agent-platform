module.exports = [
"[project]/src/lib/db.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "prisma",
    ()=>prisma
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__ = __turbopack_context__.i("[externals]/@prisma/client [external] (@prisma/client, cjs, [project]/node_modules/@prisma/client)");
;
const globalForPrisma = globalThis;
function createClient() {
    return new __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["PrismaClient"]({
        log: ("TURBOPACK compile-time truthy", 1) ? [
            'error',
            'warn'
        ] : "TURBOPACK unreachable"
    });
}
const prisma = globalForPrisma.prisma ?? createClient();
if ("TURBOPACK compile-time truthy", 1) globalForPrisma.prisma = prisma;
}),
"[project]/src/lib/agent-lifecycle.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "AGENT_STATUS_TRANSITIONS",
    ()=>AGENT_STATUS_TRANSITIONS,
    "assertTransition",
    ()=>assertTransition,
    "canTransition",
    ()=>canTransition,
    "isAvailableOnMcp",
    ()=>isAvailableOnMcp,
    "isDispatchable",
    ()=>isDispatchable,
    "isPhysicallyDeletable",
    ()=>isPhysicallyDeletable
]);
const AGENT_STATUS_TRANSITIONS = {
    draft: [
        'active'
    ],
    active: [
        'suspended',
        'retired'
    ],
    suspended: [
        'active',
        'retired'
    ],
    retired: []
};
function canTransition(from, to) {
    return AGENT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw new Error(`Invalid agent lifecycle transition: ${from} → ${to}`);
    }
}
function isDispatchable(status) {
    return status === 'active';
}
function isAvailableOnMcp(agent) {
    return Boolean(agent.currentDefinitionVersionId) && isDispatchable(agent.status);
}
function isPhysicallyDeletable(status) {
    return status === 'draft';
}
}),
"[project]/src/lib/list-pagination.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Control-plane lista pagináció — közös limitek és take+1 / hasMore minta.
 * Full dump csak explicit `unbounded: true` mellett (admin/export).
 */ __turbopack_context__.s([
    "BOARD_LIST_LIMIT",
    ()=>BOARD_LIST_LIMIT,
    "DEFAULT_LIST_LIMIT",
    ()=>DEFAULT_LIST_LIMIT,
    "MAX_LIST_LIMIT",
    ()=>MAX_LIST_LIMIT,
    "prismaPageArgs",
    ()=>prismaPageArgs,
    "resolveListLimit",
    ()=>resolveListLimit,
    "resolveListOffset",
    ()=>resolveListOffset,
    "toListPage",
    ()=>toListPage
]);
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const BOARD_LIST_LIMIT = 100;
function resolveListLimit(opts) {
    if (opts?.unbounded) return undefined;
    const raw = opts?.limit ?? DEFAULT_LIST_LIMIT;
    return Math.min(Math.max(1, raw), MAX_LIST_LIMIT);
}
function resolveListOffset(opts) {
    return Math.max(0, opts?.offset ?? 0);
}
function prismaPageArgs(opts) {
    const limit = resolveListLimit(opts);
    if (limit === undefined) return {};
    const offset = resolveListOffset(opts);
    return {
        take: limit + 1,
        skip: offset,
        pageLimit: limit
    };
}
function toListPage(rows, pageLimit, offset) {
    if (pageLimit === undefined) {
        return {
            items: rows,
            hasMore: false
        };
    }
    const hasMore = rows.length > pageLimit;
    const items = hasMore ? rows.slice(0, pageLimit) : rows;
    return {
        items,
        hasMore,
        nextOffset: hasMore ? offset + pageLimit : undefined
    };
}
}),
"[project]/src/repositories/postgres/agent-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresAgentRepository",
    ()=>PostgresAgentRepository
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$agent$2d$lifecycle$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/agent-lifecycle.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$list$2d$pagination$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/list-pagination.ts [app-rsc] (ecmascript)");
;
;
;
function agentVisibilityWhere(id, tenantId) {
    return tenantId === undefined ? {
        id
    } : {
        id,
        tenantId
    };
}
function agentListWhere(filter) {
    const where = {};
    if (filter?.tenantId !== undefined) where.tenantId = filter.tenantId;
    if (filter?.status) where.status = filter.status;
    if (filter?.ids !== undefined) where.id = {
        in: filter.ids
    };
    return Object.keys(where).length > 0 ? where : undefined;
}
class PostgresAgentRepository {
    async findMany(filter) {
        const page = await this.listPage(filter?.limit !== undefined || filter?.offset !== undefined || filter?.unbounded ? filter : {
            ...filter,
            unbounded: true
        });
        return page.items;
    }
    async listPage(filter) {
        const { take, skip, pageLimit } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$list$2d$pagination$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prismaPageArgs"])(filter);
        const offset = skip ?? 0;
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.findMany({
            where: agentListWhere(filter),
            orderBy: {
                createdAt: 'desc'
            },
            ...take !== undefined ? {
                take,
                skip: offset
            } : {}
        });
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$list$2d$pagination$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["toListPage"])(rows, pageLimit, offset);
    }
    async count(filter) {
        const where = {};
        if (filter?.tenantId !== undefined) where.tenantId = filter.tenantId;
        if (filter?.status) where.status = filter.status;
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.count({
            where: Object.keys(where).length > 0 ? where : undefined
        });
    }
    async findById(id, tenantId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.findFirst({
            where: agentVisibilityWhere(id, tenantId)
        });
    }
    async create(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.create({
            data: {
                name: input.name,
                roleInstruction: input.roleInstruction,
                tenantId: input.tenantId,
                status: input.status ?? 'draft',
                ...input.description !== undefined ? {
                    description: input.description
                } : {}
            }
        });
    }
    async updateInstruction(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: input.agentId
            },
            data: {
                roleInstruction: input.roleInstruction
            }
        });
    }
    async updateProfile(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: input.agentId
            },
            data: {
                ...input.name !== undefined ? {
                    name: input.name
                } : {},
                ...input.description !== undefined ? {
                    description: input.description
                } : {}
            }
        });
    }
    async updateAvatar(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: input.agentId
            },
            data: {
                avatarUrl: input.avatarUrl
            }
        });
    }
    async updateMemoryWriteMode(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: input.agentId
            },
            data: {
                memoryWriteMode: input.memoryWriteMode
            }
        });
    }
    async updateOutputFolder(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: input.agentId
            },
            data: {
                outputDriveFolderId: input.folderId
            }
        });
    }
    async setCurrentDefinitionVersionId(agentId, versionId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: agentId
            },
            data: {
                currentDefinitionVersionId: versionId
            }
        });
    }
    async activate(agentId) {
        const agent = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.findUnique({
            where: {
                id: agentId
            }
        });
        if (!agent) throw new Error('Agent not found');
        if (!agent.currentDefinitionVersionId) {
            throw new Error('Előbb tedd közzé a definíciót, aztán aktiválhatod.');
        }
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$agent$2d$lifecycle$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["assertTransition"])(agent.status, 'active');
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: agentId
            },
            data: {
                status: 'active',
                retiredAt: null
            }
        });
    }
    async suspend(agentId, _reason) {
        const agent = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.findUnique({
            where: {
                id: agentId
            }
        });
        if (!agent) throw new Error('Agent not found');
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$agent$2d$lifecycle$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["assertTransition"])(agent.status, 'suspended');
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: agentId
            },
            data: {
                status: 'suspended'
            }
        });
    }
    async resume(agentId) {
        const agent = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.findUnique({
            where: {
                id: agentId
            }
        });
        if (!agent) throw new Error('Agent not found');
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$agent$2d$lifecycle$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["assertTransition"])(agent.status, 'active');
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: agentId
            },
            data: {
                status: 'active'
            }
        });
    }
    async retire(agentId) {
        const agent = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.findUnique({
            where: {
                id: agentId
            }
        });
        if (!agent) throw new Error('Agent not found');
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$agent$2d$lifecycle$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["assertTransition"])(agent.status, 'retired');
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
            where: {
                id: agentId
            },
            data: {
                status: 'retired',
                retiredAt: new Date()
            }
        });
    }
    async delete(agentId, opts) {
        const agent = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.findUnique({
            where: {
                id: agentId
            }
        });
        if (!agent) throw new Error('Agent not found');
        if (!opts?.force && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$agent$2d$lifecycle$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isPhysicallyDeletable"])(agent.status)) {
            throw new Error('Csak vázlat törölhető.');
        }
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.delete({
            where: {
                id: agentId
            }
        });
    }
    async findCapabilitiesForAgent(agentId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].capability.findMany({
            where: {
                agentId
            },
            select: {
                toolName: true,
                allowed: true
            },
            orderBy: {
                toolName: 'asc'
            }
        });
    }
    async findConnectorsForAgent(agentId) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentConnector.findMany({
            where: {
                agentId
            },
            include: {
                connector: true
            },
            orderBy: {
                connectorId: 'asc'
            }
        });
        return rows.map((row)=>({
                connector: row.connector,
                accessMode: row.accessMode
            }));
    }
    async replaceCapabilities(agentId, toolNames) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction([
            __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].capability.deleteMany({
                where: {
                    agentId
                }
            }),
            ...toolNames.length > 0 ? [
                __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].capability.createMany({
                    data: toolNames.map((toolName)=>({
                            agentId,
                            toolName,
                            allowed: true
                        }))
                })
            ] : []
        ]);
    }
    async upsertConnectorBinding(input) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentConnector.upsert({
            where: {
                agentId_connectorId: {
                    agentId: input.agentId,
                    connectorId: input.connectorId
                }
            },
            create: {
                agentId: input.agentId,
                connectorId: input.connectorId,
                accessMode: input.accessMode
            },
            update: {
                accessMode: input.accessMode
            }
        });
    }
}
}),
"[project]/src/repositories/postgres/agent-definition-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresAgentDefinitionRepository",
    ()=>PostgresAgentDefinitionRepository
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
;
class PostgresAgentDefinitionRepository {
    async create(data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentDefinitionVersion.create({
            data
        });
    }
    async findById(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentDefinitionVersion.findUnique({
            where: {
                id
            }
        });
    }
    async findByAgentAndVersion(agentId, version) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentDefinitionVersion.findUnique({
            where: {
                agentId_version: {
                    agentId,
                    version
                }
            }
        });
    }
    async findMaxVersion(agentId) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentDefinitionVersion.aggregate({
            where: {
                agentId
            },
            _max: {
                version: true
            }
        });
        return row._max.version ?? 0;
    }
}
}),
"[project]/src/repositories/postgres/connector-grant-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresConnectorGrantRepository",
    ()=>PostgresConnectorGrantRepository
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
;
class PostgresConnectorGrantRepository {
    async findActiveGrant(params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.findFirst({
            where: {
                tenantId: params.tenantId,
                connectorId: params.connectorId,
                userId: params.userId,
                status: 'active',
                connector: {
                    lifecycleState: 'active'
                }
            }
        });
    }
    async findActiveByConnector(connectorId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.findMany({
            where: {
                connectorId,
                status: 'active'
            }
        });
    }
    async findActiveForInactiveConnectors(userId, tenantId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.findMany({
            where: {
                userId,
                status: 'active',
                ...tenantId ? {
                    tenantId
                } : {},
                connector: {
                    lifecycleState: {
                        not: 'active'
                    }
                }
            }
        });
    }
    async findByUser(userId, tenantId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.findMany({
            where: {
                userId,
                ...tenantId ? {
                    tenantId
                } : {}
            },
            include: {
                connector: {
                    select: {
                        id: true,
                        name: true,
                        type: true,
                        lifecycleState: true
                    }
                }
            },
            orderBy: {
                grantedAt: 'desc'
            }
        });
    }
    async create(data) {
        const existing = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.findFirst({
            where: {
                tenantId: data.tenantId,
                connectorId: data.connectorId,
                userId: data.userId
            }
        });
        const payload = {
            scopes: data.scopes,
            tokenRef: data.tokenRef,
            accountLabel: data.accountLabel ?? null,
            expiresAt: data.expiresAt ?? null,
            status: 'active',
            revokedAt: null
        };
        if (existing) {
            return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.update({
                where: {
                    id: existing.id
                },
                data: {
                    ...payload,
                    grantedAt: new Date()
                }
            });
        }
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.create({
            data: {
                tenantId: data.tenantId,
                connectorId: data.connectorId,
                userId: data.userId,
                ...payload
            }
        });
    }
    async updateStatus(id, status, extra) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.update({
            where: {
                id
            },
            data: {
                status,
                ...extra
            }
        });
    }
    async revokeAllForUser(userId) {
        const result = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.updateMany({
            where: {
                userId,
                status: 'active'
            },
            data: {
                status: 'revoked',
                revokedAt: new Date()
            }
        });
        return result.count;
    }
    async findById(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.findUnique({
            where: {
                id
            }
        });
    }
    async updateMetadata(id, metadata) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorGrant.update({
            where: {
                id
            },
            data: {
                metadata
            }
        });
    }
}
}),
"[project]/src/domain/connector/github-repository-access.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "GITHUB_REPOSITORY_LIST_PATTERN_SOURCE",
    ()=>GITHUB_REPOSITORY_LIST_PATTERN_SOURCE,
    "GITHUB_REPOSITORY_PATTERN",
    ()=>GITHUB_REPOSITORY_PATTERN,
    "GITHUB_REPOSITORY_PATTERN_SOURCE",
    ()=>GITHUB_REPOSITORY_PATTERN_SOURCE,
    "MAX_GITHUB_REPOSITORIES",
    ()=>MAX_GITHUB_REPOSITORIES,
    "gitHubRepositoryAccessFromText",
    ()=>gitHubRepositoryAccessFromText,
    "parseGitHubRepositoryAccessConfig",
    ()=>parseGitHubRepositoryAccessConfig
]);
const MAX_GITHUB_REPOSITORIES = 100;
const GITHUB_REPOSITORY_PATTERN_SOURCE = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';
const GITHUB_REPOSITORY_PATTERN = new RegExp(`^${GITHUB_REPOSITORY_PATTERN_SOURCE}$`);
const GITHUB_REPOSITORY_LIST_PATTERN_SOURCE = `^(?:\\*|${GITHUB_REPOSITORY_PATTERN_SOURCE}(?:[\\s,]+${GITHUB_REPOSITORY_PATTERN_SOURCE})*)$`;
function normalizeRepository(repository) {
    if (typeof repository !== 'string' || !GITHUB_REPOSITORY_PATTERN.test(repository.trim())) {
        throw new Error(`GitHub repository must use owner/repo format: ${String(repository)}`);
    }
    return repository.trim().toLowerCase();
}
function normalizeRepositories(repositories) {
    const normalized = [
        ...new Set(repositories.map(normalizeRepository))
    ];
    if (normalized.length === 0) {
        throw new Error('Selected GitHub repository access requires at least one owner/repo value');
    }
    if (normalized.length > MAX_GITHUB_REPOSITORIES) {
        throw new Error(`Selected GitHub repository access supports at most ${MAX_GITHUB_REPOSITORIES} repositories`);
    }
    return normalized;
}
function gitHubRepositoryAccessFromText(value) {
    const trimmed = value.trim();
    if (trimmed === '*') return {
        mode: 'any'
    };
    return {
        mode: 'selected',
        repositories: normalizeRepositories(trimmed.split(/[\s,]+/).filter(Boolean))
    };
}
function parseGitHubRepositoryAccessConfig(raw) {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('GitHub repository access must be an object');
    }
    const value = raw;
    if (value.mode === 'any') return {
        mode: 'any'
    };
    if (value.mode !== 'selected' || !Array.isArray(value.repositories)) {
        throw new Error('GitHub repository access mode must be "any" or "selected"');
    }
    return {
        mode: 'selected',
        repositories: normalizeRepositories(value.repositories)
    };
}
}),
"[project]/src/domain/connector/github-repository-access-schema.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "githubRepositoryAccessSchema",
    ()=>githubRepositoryAccessSchema
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__ = __turbopack_context__.i("[project]/node_modules/zod/v4/classic/external.js [app-rsc] (ecmascript) <export * as z>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$github$2d$repository$2d$access$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector/github-repository-access.ts [app-rsc] (ecmascript)");
;
;
const githubRepositoryAccessSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].unknown().transform((value, context)=>{
    try {
        const parsed = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$github$2d$repository$2d$access$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["parseGitHubRepositoryAccessConfig"])(value);
        if (!parsed) throw new Error('GitHub repository access is required');
        return parsed;
    } catch (error) {
        context.addIssue({
            code: 'custom',
            message: error instanceof Error ? error.message : 'Invalid GitHub repository access'
        });
        return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].NEVER;
    }
});
}),
"[project]/src/domain/privacy/surrogate-format.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Típusos álnév formátuma (AI Privacy Gateway spec §5, issue #320 D1/D3).
 *
 * Alak: `[[COMPANY@S2_1]]` — entitástípus nagybetűvel, opcionális forrásbélyeg
 * (`@S{n}`), majd beszélgetésen belüli 1-alapú sorszám. A régi bélyeg nélküli
 * `[[COMPANY_1]]` továbbra is parse-olható (visszafelé kompatibilitás).
 *
 * Az entitástípus kulcsa forrás-definiált slug; a platform nem tart nyilván
 * zárt listát. Az alapöt típus seed alapértelmezésként megmarad a nem
 * nyilatkozó forrásokhoz.
 */ __turbopack_context__.s([
    "DEFAULT_SURROGATE_ENTITY_TYPES",
    ()=>DEFAULT_SURROGATE_ENTITY_TYPES,
    "ENTITY_TYPE_SLUG_RE",
    ()=>ENTITY_TYPE_SLUG_RE,
    "SURROGATE_ENTITY_TYPES",
    ()=>SURROGATE_ENTITY_TYPES,
    "UnknownEntityTypeError",
    ()=>UnknownEntityTypeError,
    "containsEmbeddedSurrogate",
    ()=>containsEmbeddedSurrogate,
    "entityTypeLabel",
    ()=>entityTypeLabel,
    "findEmbeddedSurrogates",
    ()=>findEmbeddedSurrogates,
    "formatPrivacySourceSlot",
    ()=>formatPrivacySourceSlot,
    "formatSurrogate",
    ()=>formatSurrogate,
    "isDefaultSurrogateEntityType",
    ()=>isDefaultSurrogateEntityType,
    "isEntityTypeSlug",
    ()=>isEntityTypeSlug,
    "isSurrogateEntityType",
    ()=>isSurrogateEntityType,
    "isSurrogatePrefix",
    ()=>isSurrogatePrefix,
    "parseSurrogate",
    ()=>parseSurrogate,
    "surrogateOrdinalKey",
    ()=>surrogateOrdinalKey
]);
const DEFAULT_SURROGATE_ENTITY_TYPES = [
    'company',
    'person',
    'email',
    'phone',
    'account'
];
const SURROGATE_ENTITY_TYPES = DEFAULT_SURROGATE_ENTITY_TYPES;
const ENTITY_TYPE_SLUG_RE = /^[a-z][a-z0-9_]{0,31}$/;
const DEFAULT_LABEL_BY_TYPE = {
    company: 'COMPANY',
    person: 'PERSON',
    email: 'EMAIL',
    phone: 'PHONE',
    account: 'ACCOUNT'
};
const DEFAULT_TYPE_BY_LABEL = Object.fromEntries(DEFAULT_SURROGATE_ENTITY_TYPES.map((entityType)=>[
        DEFAULT_LABEL_BY_TYPE[entityType],
        entityType
    ]));
/** Teljes álnév: `[[TYPE_N]]` vagy `[[TYPE@S2_N]]`, N ≥ 1. */ const SURROGATE_EXACT = /^\[\[([A-Z][A-Z0-9_]*)(?:@(S[0-9]+))?_([1-9][0-9]*)\]\]$/;
/** Beágyazott álnév szövegben. A típusnév-ellenőrzést a `parseSurrogate` adja. */ const SURROGATE_EMBEDDED = /\[\[([A-Z][A-Z0-9_]*)(?:@(S[0-9]+))?_([1-9][0-9]*)\]\]/g;
class UnknownEntityTypeError extends Error {
    entityType;
    constructor(entityType){
        super(`ismeretlen entitástípus: ${entityType}`);
        this.name = 'UnknownEntityTypeError';
        this.entityType = entityType;
    }
}
function isEntityTypeSlug(value) {
    return ENTITY_TYPE_SLUG_RE.test(value);
}
function isDefaultSurrogateEntityType(value) {
    return DEFAULT_SURROGATE_ENTITY_TYPES.includes(value);
}
function isSurrogateEntityType(value) {
    return isEntityTypeSlug(value);
}
function formatPrivacySourceSlot(slot) {
    if (!Number.isInteger(slot) || slot < 1) {
        throw new RangeError(`a forrás-sorszám legalább 1 legyen, kapott: ${slot}`);
    }
    return `S${slot}`;
}
function entityTypeLabel(entityType) {
    if (!isEntityTypeSlug(entityType)) throw new UnknownEntityTypeError(entityType);
    if (isDefaultSurrogateEntityType(entityType)) return DEFAULT_LABEL_BY_TYPE[entityType];
    return entityType.toUpperCase();
}
function labelToEntityType(label) {
    const fromDefault = DEFAULT_TYPE_BY_LABEL[label];
    if (fromDefault) return fromDefault;
    const slug = label.toLowerCase();
    return isEntityTypeSlug(slug) ? slug : null;
}
function formatSurrogate(entityType, ordinal, sourceSlot) {
    if (!isEntityTypeSlug(entityType)) throw new UnknownEntityTypeError(entityType);
    if (!Number.isInteger(ordinal) || ordinal < 1) {
        throw new RangeError(`az álnév sorszáma legalább 1 legyen, kapott: ${ordinal}`);
    }
    const label = entityTypeLabel(entityType);
    if (sourceSlot) {
        return `[[${label}@${sourceSlot}_${ordinal}]]`;
    }
    return `[[${label}_${ordinal}]]`;
}
function parseSurrogateMatch(match) {
    const entityType = labelToEntityType(match[1] ?? '');
    if (!entityType) return null;
    const sourceSlot = match[2] || undefined;
    return {
        entityType,
        ordinal: Number(match[3]),
        sourceSlot
    };
}
function parseSurrogate(text) {
    const match = SURROGATE_EXACT.exec(text);
    if (!match) return null;
    return parseSurrogateMatch(match);
}
function containsEmbeddedSurrogate(text) {
    if (!text) return false;
    return findEmbeddedSurrogates(text).some((match)=>match.parsed != null);
}
function findEmbeddedSurrogates(text) {
    const found = [];
    const re = new RegExp(SURROGATE_EMBEDDED.source, 'g');
    for (const match of text.matchAll(re)){
        const raw = match[0];
        const start = match.index ?? 0;
        found.push({
            start,
            end: start + raw.length,
            text: raw,
            parsed: parseSurrogate(raw)
        });
    }
    return found;
}
function isSurrogatePrefix(text) {
    if (text === '[') return true;
    if (!text.startsWith('[[')) return false;
    if (text.includes(']]')) return false;
    const inner = text.slice(2);
    return inner === '' || /^[A-Z]+$/.test(inner) || /^[A-Z]+_$/.test(inner) || /^[A-Z]+_[1-9][0-9]*$/.test(inner) || /^[A-Z]+_[1-9][0-9]*\]$/.test(inner) || /^[A-Z]+@S[0-9]+$/.test(inner) || /^[A-Z]+@S[0-9]+_$/.test(inner) || /^[A-Z]+@S[0-9]+_[1-9][0-9]*$/.test(inner) || /^[A-Z]+@S[0-9]+_[1-9][0-9]*\]$/.test(inner);
}
function surrogateOrdinalKey(entityType, sourceSlot) {
    return `${entityType}\0${sourceSlot ?? ''}`;
}
}),
"[project]/src/domain/privacy/connector-privacy.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "DEFAULT_ENTITY_TYPE_DECLARATIONS",
    ()=>DEFAULT_ENTITY_TYPE_DECLARATIONS,
    "DEFAULT_PRIVACY_CATALOG_PATH",
    ()=>DEFAULT_PRIVACY_CATALOG_PATH,
    "OSTOROSBOR_CRM_PRIVACY_CAPABILITIES",
    ()=>OSTOROSBOR_CRM_PRIVACY_CAPABILITIES,
    "OSTOROSBOR_CRM_PRIVACY_CATALOG",
    ()=>OSTOROSBOR_CRM_PRIVACY_CATALOG,
    "OSTOROSBOR_CRM_PRIVACY_FIELDS",
    ()=>OSTOROSBOR_CRM_PRIVACY_FIELDS,
    "OSTOROSBOR_CRM_TEMPLATE_KEYS",
    ()=>OSTOROSBOR_CRM_TEMPLATE_KEYS,
    "PRIVACY_CAPABILITY_KEYS",
    ()=>PRIVACY_CAPABILITY_KEYS,
    "PRIVACY_FIELD_ACTIONS",
    ()=>PRIVACY_FIELD_ACTIONS,
    "PRIVACY_FIELD_VALUE_TYPES",
    ()=>PRIVACY_FIELD_VALUE_TYPES,
    "PRIVACY_UNLISTED_DEFAULTS",
    ()=>PRIVACY_UNLISTED_DEFAULTS,
    "TOKENIZE_ENTITY_TYPE_MESSAGE",
    ()=>TOKENIZE_ENTITY_TYPE_MESSAGE,
    "TOKENIZE_IRREVERSIBLE_MESSAGE",
    ()=>TOKENIZE_IRREVERSIBLE_MESSAGE,
    "TOKENIZE_SOURCE_ID_REFERENCE_MESSAGE",
    ()=>TOKENIZE_SOURCE_ID_REFERENCE_MESSAGE,
    "TOKENIZE_STRING_ONLY_MESSAGE",
    ()=>TOKENIZE_STRING_ONLY_MESSAGE,
    "buildConnectorFieldsPrivacySchema",
    ()=>buildConnectorFieldsPrivacySchema,
    "canonicalizePrivacyDeclaration",
    ()=>canonicalizePrivacyDeclaration,
    "collectConnectorEntityTypeSlugs",
    ()=>collectConnectorEntityTypeSlugs,
    "connectorFieldPrivacySchema",
    ()=>connectorFieldPrivacySchema,
    "connectorFieldsPrivacySchema",
    ()=>connectorFieldsPrivacySchema,
    "connectorHasPrivacyMetadata",
    ()=>connectorHasPrivacyMetadata,
    "connectorSupportsEntityResolution",
    ()=>connectorSupportsEntityResolution,
    "inspectConnectorPrivacyFields",
    ()=>inspectConnectorPrivacyFields,
    "parsePrivacyCatalogV2",
    ()=>parsePrivacyCatalogV2,
    "privacyCapabilityAbsentAudit",
    ()=>privacyCapabilityAbsentAudit,
    "privacyCapabilityAuditMetadata",
    ()=>privacyCapabilityAuditMetadata,
    "privacyCapabilityChangedAudit",
    ()=>privacyCapabilityChangedAudit,
    "privacyCapabilityDeclarationSchema",
    ()=>privacyCapabilityDeclarationSchema,
    "privacyCapabilityLevel",
    ()=>privacyCapabilityLevel,
    "privacyCapabilityUi",
    ()=>privacyCapabilityUi,
    "privacyCatalogToConnectorConfigPatch",
    ()=>privacyCatalogToConnectorConfigPatch,
    "privacyCatalogV2Schema",
    ()=>privacyCatalogV2Schema,
    "privacyDeclarationsEqual",
    ()=>privacyDeclarationsEqual,
    "privacyEntityTypeDeclarationSchema",
    ()=>privacyEntityTypeDeclarationSchema,
    "privacyEntityTypesSchema",
    ()=>privacyEntityTypesSchema,
    "readConnectorEntityTypes",
    ()=>readConnectorEntityTypes,
    "readConnectorPrivacyFields",
    ()=>readConnectorPrivacyFields,
    "readConnectorUnlistedDefault",
    ()=>readConnectorUnlistedDefault,
    "readEntityResolvePath",
    ()=>readEntityResolvePath,
    "readPrivacyCatalogPath",
    ()=>readPrivacyCatalogPath,
    "readPrivacyDeclaration",
    ()=>readPrivacyDeclaration,
    "refineTokenizeReversibility",
    ()=>refineTokenizeReversibility,
    "reviewPrivacyCatalogDeclarations",
    ()=>reviewPrivacyCatalogDeclarations
]);
/**
 * Connector privacy metadata + capability-deklaráció (APG-03, spec §7 / §11, issue #320).
 *
 * A mezőséma a connector `config` / `ConnectorSpecVersion.capabilitySet` része.
 * `privacy: tokenize` csak string mezőre érvényes (R6). Az entitástípus-névtér
 * forrás-definiált; a platform csak a `reversible` invariánst kényszeríti ki.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__ = __turbopack_context__.i("[project]/node_modules/zod/v4/classic/external.js [app-rsc] (ecmascript) <export * as z>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$surrogate$2d$format$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/privacy/surrogate-format.ts [app-rsc] (ecmascript)");
;
;
const PRIVACY_FIELD_ACTIONS = [
    'tokenize',
    'pass',
    'block'
];
const PRIVACY_UNLISTED_DEFAULTS = [
    'pass',
    'block'
];
const PRIVACY_FIELD_VALUE_TYPES = [
    'string',
    'number',
    'integer',
    'boolean',
    'date',
    'datetime'
];
const PRIVACY_CAPABILITY_KEYS = [
    'structured_field_privacy',
    'stable_entity_ids',
    'entity_resolution',
    'free_text_hints'
];
const TOKENIZE_STRING_ONLY_MESSAGE = 'A tokenize adatvédelem csak szöveges (string) mezőre alkalmazható; numerikus és dátum mezőn tilos.';
const TOKENIZE_ENTITY_TYPE_MESSAGE = 'A tokenize mezőhöz entitástípus kell (forrás-definiált slug, pl. company vagy ingatlan).';
const TOKENIZE_IRREVERSIBLE_MESSAGE = 'A tokenize adatvédelem csak visszafordítható (reversible: true) entitástípusra alkalmazható.';
const TOKENIZE_SOURCE_ID_REFERENCE_MESSAGE = 'A source_id sablon csak a payload-sémában deklarált mezőre hivatkozhat.';
const SOURCE_ID_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const entityTypeSlugSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().regex(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$surrogate$2d$format$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ENTITY_TYPE_SLUG_RE"], 'Az entitástípus slug csak kisbetű, szám és aláhúzás lehet (max. 32 karakter).');
const privacyEntityTypeDeclarationSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    label: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
    reversible: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].boolean()
});
const DEFAULT_ENTITY_TYPE_DECLARATIONS = Object.fromEntries([
    [
        'company',
        {
            label: 'Cég',
            reversible: true
        }
    ],
    [
        'person',
        {
            label: 'Személy',
            reversible: true
        }
    ],
    [
        'email',
        {
            label: 'E-mail',
            reversible: true
        }
    ],
    [
        'phone',
        {
            label: 'Telefon',
            reversible: true
        }
    ],
    [
        'account',
        {
            label: 'Számla',
            reversible: true
        }
    ]
].filter(([key])=>__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$surrogate$2d$format$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["DEFAULT_SURROGATE_ENTITY_TYPES"].includes(key)));
const privacyEntityTypesSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].record(entityTypeSlugSchema, privacyEntityTypeDeclarationSchema);
const privacyCapabilityDeclarationSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    structured_field_privacy: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].boolean(),
    stable_entity_ids: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].boolean(),
    entity_resolution: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].boolean(),
    free_text_hints: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].boolean()
});
const connectorFieldPrivacyObjectSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    type: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum(PRIVACY_FIELD_VALUE_TYPES).optional(),
    privacy: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum(PRIVACY_FIELD_ACTIONS).default('pass'),
    entity_type: entityTypeSlugSchema.optional(),
    source_id: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1).optional()
});
function validateFieldAgainstEntityTypes(field, entityTypes, ctx, pathPrefix) {
    if (field.privacy !== 'tokenize') return;
    if (field.type !== 'string') {
        ctx.addIssue({
            code: 'custom',
            path: [
                ...pathPrefix,
                'privacy'
            ],
            message: TOKENIZE_STRING_ONLY_MESSAGE
        });
    }
    if (!field.entity_type) {
        ctx.addIssue({
            code: 'custom',
            path: [
                ...pathPrefix,
                'entity_type'
            ],
            message: TOKENIZE_ENTITY_TYPE_MESSAGE
        });
        return;
    }
    const declaration = entityTypes?.[field.entity_type];
    if (declaration && declaration.reversible === false) {
        ctx.addIssue({
            code: 'custom',
            path: [
                ...pathPrefix,
                'entity_type'
            ],
            message: TOKENIZE_IRREVERSIBLE_MESSAGE
        });
    }
}
const connectorFieldPrivacySchema = connectorFieldPrivacyObjectSchema;
function refineTokenizeReversibility(fields, entityTypes, ctx, pathPrefix = []) {
    for (const [fieldName, field] of Object.entries(fields)){
        if (field.privacy !== 'tokenize' || !field.entity_type) continue;
        if (entityTypes[field.entity_type]?.reversible === false) {
            ctx.addIssue({
                code: 'custom',
                path: [
                    ...pathPrefix,
                    fieldName,
                    'entity_type'
                ],
                message: TOKENIZE_IRREVERSIBLE_MESSAGE
            });
        }
    }
}
function buildConnectorFieldsPrivacySchema(entityTypes) {
    return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].record(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1), connectorFieldPrivacyObjectSchema).superRefine((fields, ctx)=>{
        const fieldNames = new Set(Object.keys(fields));
        for (const [fieldName, field] of Object.entries(fields)){
            validateFieldAgainstEntityTypes(field, entityTypes, ctx, [
                fieldName
            ]);
            if (field.privacy !== 'tokenize' || !field.source_id) continue;
            for (const match of field.source_id.matchAll(SOURCE_ID_PLACEHOLDER)){
                const referenced = match[1];
                if (referenced && !fieldNames.has(referenced)) {
                    ctx.addIssue({
                        code: 'custom',
                        path: [
                            fieldName,
                            'source_id'
                        ],
                        message: `${TOKENIZE_SOURCE_ID_REFERENCE_MESSAGE} Hiányzó mező: ${referenced}.`
                    });
                }
            }
        }
    });
}
const connectorFieldsPrivacySchema = buildConnectorFieldsPrivacySchema();
const privacyCatalogV2Schema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    catalog_version: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().int().positive(),
    system: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1).optional(),
    entity_types: privacyEntityTypesSchema.optional(),
    unlisted_default: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum(PRIVACY_UNLISTED_DEFAULTS).optional(),
    privacy: privacyCapabilityDeclarationSchema.optional(),
    fields: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].record(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1), connectorFieldPrivacyObjectSchema)
}).superRefine((catalog, ctx)=>{
    const entityTypes = {
        ...DEFAULT_ENTITY_TYPE_DECLARATIONS,
        ...catalog.entity_types
    };
    for (const [fieldName, field] of Object.entries(catalog.fields)){
        validateFieldAgainstEntityTypes(field, entityTypes, ctx, [
            'fields',
            fieldName
        ]);
    }
});
const SECRET_HEURISTICS = [
    {
        pattern: /-----BEGIN/i,
        reason: 'PEM/titok blokk minta'
    },
    {
        pattern: /^sk-[A-Za-z0-9]{8,}/,
        reason: 'API-kulcs minta (sk-…)'
    },
    {
        pattern: /^[A-Za-z0-9+/=]{40,}$/,
        reason: 'magas entrópia / base64-szerű érték'
    }
];
function reviewPrivacyCatalogDeclarations(catalog, samples = []) {
    const warnings = [];
    for (const [fieldName, field] of Object.entries(catalog.fields)){
        if (field.privacy !== 'pass' || field.type !== 'string') continue;
        const values = samples.map((sample)=>sample[fieldName]).filter((value)=>typeof value === 'string' && value.trim() !== '');
        const hit = SECRET_HEURISTICS.find((heuristic)=>values.some((value)=>heuristic.pattern.test(value.trim())));
        if (hit) warnings.push({
            field: fieldName,
            reason: hit.reason
        });
    }
    return warnings;
}
function parsePrivacyCatalogV2(raw) {
    const parsed = privacyCatalogV2Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
function privacyCatalogToConnectorConfigPatch(catalog) {
    return {
        catalog_version: catalog.catalog_version,
        ...catalog.privacy ? {
            privacy: catalog.privacy
        } : {},
        ...catalog.entity_types ? {
            entity_types: catalog.entity_types
        } : {},
        ...catalog.unlisted_default ? {
            unlisted_default: catalog.unlisted_default
        } : {},
        fields: catalog.fields
    };
}
function readConnectorEntityTypes(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return {
            ...DEFAULT_ENTITY_TYPE_DECLARATIONS
        };
    }
    const entityTypes = config.entity_types;
    const parsed = privacyEntityTypesSchema.safeParse(entityTypes);
    if (!parsed.success) return {
        ...DEFAULT_ENTITY_TYPE_DECLARATIONS
    };
    return {
        ...DEFAULT_ENTITY_TYPE_DECLARATIONS,
        ...parsed.data
    };
}
function readConnectorUnlistedDefault(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return 'pass';
    const value = config.unlisted_default;
    return value === 'block' ? 'block' : 'pass';
}
const OSTOROSBOR_CRM_TEMPLATE_KEYS = new Set([
    'ostorosbor-crm-sales-delegated',
    'ostorosbor-crm-service-insight'
]);
const OSTOROSBOR_CRM_PRIVACY_CATALOG = {
    catalog_version: 1,
    system: 'crm',
    entity_types: {
        company: {
            label: 'Cég',
            reversible: true
        }
    },
    unlisted_default: 'pass',
    privacy: {
        structured_field_privacy: true,
        stable_entity_ids: true,
        entity_resolution: false,
        free_text_hints: false
    },
    fields: {
        id: {
            type: 'integer',
            privacy: 'pass'
        },
        company_name: {
            type: 'string',
            privacy: 'tokenize',
            entity_type: 'company',
            source_id: 'crm/company/{id}'
        },
        name: {
            type: 'string',
            privacy: 'tokenize',
            entity_type: 'company',
            source_id: 'crm/company/{id}'
        },
        revenue: {
            type: 'number',
            privacy: 'pass'
        }
    }
};
const OSTOROSBOR_CRM_PRIVACY_CAPABILITIES = OSTOROSBOR_CRM_PRIVACY_CATALOG.privacy;
const OSTOROSBOR_CRM_PRIVACY_FIELDS = OSTOROSBOR_CRM_PRIVACY_CATALOG.fields;
function privacyCapabilityLevel(declaration) {
    if (!declaration) return 'none';
    const enabled = PRIVACY_CAPABILITY_KEYS.filter((key)=>declaration[key]);
    if (enabled.length === 0) return 'none';
    if (declaration.structured_field_privacy && declaration.stable_entity_ids) return 'full';
    return 'partial';
}
function canonicalizePrivacyDeclaration(declaration) {
    if (!declaration) return null;
    return {
        structured_field_privacy: declaration.structured_field_privacy,
        stable_entity_ids: declaration.stable_entity_ids,
        entity_resolution: declaration.entity_resolution,
        free_text_hints: declaration.free_text_hints
    };
}
function privacyDeclarationsEqual(left, right) {
    return JSON.stringify(canonicalizePrivacyDeclaration(left)) === JSON.stringify(canonicalizePrivacyDeclaration(right));
}
function readConnectorPrivacyFields(config) {
    const inspected = inspectConnectorPrivacyFields(config);
    return inspected.status === 'valid' ? inspected.fields : null;
}
function inspectConnectorPrivacyFields(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return {
        status: 'absent'
    };
    const fields = config.fields;
    if (fields === undefined) return {
        status: 'absent'
    };
    const entityTypes = readConnectorEntityTypes(config);
    const parsed = buildConnectorFieldsPrivacySchema(entityTypes).safeParse(fields);
    if (parsed.success) return {
        status: 'valid',
        fields: parsed.data
    };
    return {
        status: 'invalid',
        reason: parsed.error.issues.slice(0, 5).map((issue)=>`${issue.path.join('.') || '(gyökér)'}: ${issue.message}`).join('; ')
    };
}
function connectorHasPrivacyMetadata(config) {
    const fields = readConnectorPrivacyFields(config);
    if (fields && Object.values(fields).some((field)=>field.privacy === 'tokenize')) return true;
    return privacyCapabilityLevel(readPrivacyDeclaration(config)) !== 'none';
}
function connectorSupportsEntityResolution(config) {
    return readPrivacyDeclaration(config)?.entity_resolution === true;
}
const DEFAULT_PRIVACY_CATALOG_PATH = '/privacy/catalog';
function readPrivacyCatalogPath(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return DEFAULT_PRIVACY_CATALOG_PATH;
    }
    const privacy = config.privacy;
    if (privacy && typeof privacy === 'object' && !Array.isArray(privacy)) {
        const path = privacy.catalog_path;
        if (typeof path === 'string' && path.trim().startsWith('/')) return path.trim();
    }
    return DEFAULT_PRIVACY_CATALOG_PATH;
}
function readEntityResolvePath(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return '/privacy/resolve';
    const privacy = config.privacy;
    if (privacy && typeof privacy === 'object' && !Array.isArray(privacy)) {
        const path = privacy.resolve_path;
        if (typeof path === 'string' && path.trim().startsWith('/')) return path.trim();
    }
    return '/privacy/resolve';
}
function readPrivacyDeclaration(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const cfg = raw;
    const parsed = privacyCapabilityDeclarationSchema.safeParse(cfg.privacy);
    if (parsed.success) return parsed.data;
    const provenance = cfg.provenance && typeof cfg.provenance === 'object' && !Array.isArray(cfg.provenance) ? cfg.provenance : null;
    const key = typeof provenance?.templateKey === 'string' ? provenance.templateKey : typeof cfg.provider === 'string' ? cfg.provider : '';
    return OSTOROSBOR_CRM_TEMPLATE_KEYS.has(key) ? OSTOROSBOR_CRM_PRIVACY_CAPABILITIES : null;
}
function collectConnectorEntityTypeSlugs(config) {
    const slugs = new Set();
    for (const key of Object.keys(readConnectorEntityTypes(config))){
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$surrogate$2d$format$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isEntityTypeSlug"])(key)) slugs.add(key);
    }
    const fields = readConnectorPrivacyFields(config);
    if (fields) {
        for (const field of Object.values(fields)){
            if (field.entity_type && (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$surrogate$2d$format$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isEntityTypeSlug"])(field.entity_type)) slugs.add(field.entity_type);
        }
    }
    return [
        ...slugs
    ].sort();
}
function privacyCapabilityAuditMetadata(declaration) {
    const canonical = canonicalizePrivacyDeclaration(declaration);
    return {
        privacy_capability: privacyCapabilityLevel(canonical),
        privacy: canonical
    };
}
function privacyCapabilityAbsentAudit(declaration) {
    if (privacyCapabilityLevel(declaration) !== 'none') return null;
    return {
        action: 'privacy.connector.capability.absent',
        metadata: privacyCapabilityAuditMetadata(null)
    };
}
function privacyCapabilityChangedAudit(input) {
    if (privacyDeclarationsEqual(input.previous, input.next)) return null;
    return {
        action: 'privacy.connector.capability.changed',
        metadata: {
            from: canonicalizePrivacyDeclaration(input.previous),
            to: canonicalizePrivacyDeclaration(input.next),
            ...privacyCapabilityAuditMetadata(input.next)
        }
    };
}
function privacyCapabilityUi(level) {
    if (level === 'full') {
        return {
            label: 'Adatvédelem beállítva',
            tone: 'success',
            title: 'A kapcsolat megmondja, mely cégneveket kell álnévre cserélni, mielőtt a modell látná őket.'
        };
    }
    if (level === 'partial') {
        return {
            label: 'Részleges adatvédelem',
            tone: 'warning',
            title: 'A kapcsolat csak részben jelöli a védendő mezőket, ezért a platform kevesebbet tud álnévre cserélni.'
        };
    }
    return {
        label: 'Korlátozott adatvédelem',
        tone: 'warning',
        title: 'Ez a kapcsolat nem jelöli a védendő mezőket. Ettől még működik, de a platform kevesebb adatot tud álnévre cserélni.'
    };
}
}),
"[project]/src/domain/provisioning/connector-config.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ConnectorConfigParseError",
    ()=>ConnectorConfigParseError,
    "HTTP_API_PROTOCOLS",
    ()=>HTTP_API_PROTOCOLS,
    "HTTP_METHODS",
    ()=>HTTP_METHODS,
    "WRITE_METHODS",
    ()=>WRITE_METHODS,
    "connectorAuthSchema",
    ()=>connectorAuthSchema,
    "connectorConfigSchema",
    ()=>connectorConfigSchema,
    "httpPaginationSchema",
    ()=>httpPaginationSchema,
    "normalizeConnectorConfig",
    ()=>normalizeConnectorConfig,
    "proposedToolSchema",
    ()=>proposedToolSchema
]);
/**
 * A provisioning-asszisztens által generált connector-deskriptor alakja
 * (Feature-spec — Provisioning-Assistant §4.3). Determinisztikusan ellenőrizhető
 * szerkezet; a draft `connectors.config`-jába kerül `lifecycle_state = draft`
 * állapotban. A séma maga NEM hoz biztonsági döntést — azt a determinisztikus
 * validátor (§4.4, draft-validator.ts) végzi.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__ = __turbopack_context__.i("[project]/node_modules/zod/v4/classic/external.js [app-rsc] (ecmascript) <export * as z>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$github$2d$repository$2d$access$2d$schema$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector/github-repository-access-schema.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/privacy/connector-privacy.ts [app-rsc] (ecmascript)");
;
;
;
const HTTP_METHODS = [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE'
];
const HTTP_API_PROTOCOLS = [
    'szamlazz_agent',
    'nav_online_invoice'
];
const WRITE_METHODS = new Set([
    'POST',
    'PUT',
    'PATCH',
    'DELETE'
]);
const paginationCommonSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    itemsPath: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
    totalPath: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1).optional(),
    defaultPageSize: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().int().positive().optional(),
    maxPageSize: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().int().positive().optional()
});
const httpPaginationSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].union([
    paginationCommonSchema.extend({
        kind: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].literal('cursor'),
        cursorParam: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
        nextCursorPath: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
        limitParam: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1).optional()
    }),
    paginationCommonSchema.extend({
        kind: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].literal('page'),
        pageParam: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
        pageSizeParam: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1).optional(),
        firstPage: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().int().min(0).default(1)
    }),
    paginationCommonSchema.extend({
        kind: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].literal('offset'),
        offsetParam: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
        limitParam: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
        firstOffset: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().int().min(0).default(0)
    }),
    paginationCommonSchema.extend({
        kind: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].literal('next_link'),
        nextLinkPath: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1).optional(),
        linkHeaderRel: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].literal('next').optional(),
        /** Opaque pathos folytatás csak erre a jóváhagyott endpoint-sablonra válthat. */ continuationPathTemplate: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1).optional()
    }).refine((value)=>Boolean(value.nextLinkPath || value.linkHeaderRel), {
        message: 'next_link pagination requires nextLinkPath or linkHeaderRel'
    }),
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
        kind: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].literal('none'),
        itemsPath: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1)
    })
]);
const proposedToolSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    name: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
    method: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum(HTTP_METHODS),
    path: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
    access: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum([
        'read',
        'write'
    ]),
    /** Következmény-kapu; hiányában access + metódus dönt. */ risk: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum([
        'read',
        'write',
        'danger'
    ]).optional(),
    description: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
    /**
   * Ha true: az endpoint írási hívásaihoz a futásidejű http-api-kliens automatikusan
   * egyedi `Idempotency-Key` fejlécet injektál (lásd http-api-client.ts). Az OpenAPI-
   * extractor akkor állítja be, ha a spec az operationön kötelező `Idempotency-Key`
   * header-paramétert deklarál. Csak mutáló metódusokon van értelme.
   */ idempotent: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].boolean().optional(),
    pagination: httpPaginationSchema.optional(),
    /** Capability-diffhez megőrzött, titokmentes paraméter-kontraktus. */ parameters: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].array(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
        name: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
        in: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum([
            'path',
            'query',
            'header',
            'cookie',
            'body'
        ]),
        required: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].boolean(),
        type: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1)
    })).optional()
});
const connectorAuthSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    type: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum([
        'api_key_header',
        'bearer_token',
        'basic',
        'oauth2',
        'none'
    ]),
    headerName: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
    /** `type: 'basic'`: nem titkos felhasználónév (pl. MiniCRM System ID); a titok a jelszó. */ username: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
    /** A secret SOSEM kerül ide — csak a Secret Managerbe szánt alias NEVE javasolt. */ secretAliasSuggested: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
    /**
   * `type: 'oauth2'` + `authMode: 'user_delegated'` esetén az OAuth authorization
   * (consent) végpont. Nem titok. Sablon-alapú connectornál explicit provider-
   * metaadatként kerül ide; futásidőben nincs provider-név alapú default.
   */ authUrl: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().url().optional(),
    /** `type: 'oauth2'` esetén kötelező a token-refresh végponthoz (nem titok). */ tokenUrl: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().url().optional(),
    /** `type: 'oauth2'` esetén kötelező a token-refresh végponthoz (nem titok). */ clientId: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
    /** `type: 'oauth2'` esetén opcionális OAuth2 scope-lista. */ scope: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
    /** Opcionális userinfo/whoami végpont a delegált grant fiók-címkéjéhez. */ userInfoUrl: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().url().optional(),
    /** A userinfo JSON melyik mezője a fiók-címke. */ accountEmailField: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
    /** OAuth authorization URL-be írandó extra paraméterek, pl. Google access_type=offline. */ offlineParams: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].record(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string(), __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string()).optional(),
    /** Deklarált scope-normalizálás; provider-tippelést vált ki a consent úton. */ scopeTransform: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum([
        'none',
        'gmailAlias'
    ]).optional()
});
const connectorConfigObjectSchema = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
    /** Az extractor szemantikai verziója; ugyanaz a nyers spec új capability-t adhat. */ capabilitySchemaVersion: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().int().positive().optional(),
    provider: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1),
    /** OpenAPI `info.description` / `info.summary` — emberi API-leírás, titok nélkül. */ description: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
    baseUrl: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().url(),
    egressHosts: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].array(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().min(1)).min(1),
    authMode: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum([
        'service',
        'user_delegated',
        'agent_owned'
    ]),
    auth: connectorAuthSchema,
    scopesSuggested: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].array(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string()).default([]),
    rateLimit: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
        rps: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().nonnegative(),
        burst: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().nonnegative()
    }).optional(),
    proposedTools: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].array(proposedToolSchema).default([]),
    /**
   * Ha true: futásidőben CSAK a `proposedTools`-ban felsorolt (method+path) hívható
   * (endpoint-allowlist, WP-3/B3). A runtime http-api-kliens ezt a `restrictToEndpoints`
   * mezőt olvassa. GitHub repo-scope connectoron tudatosan nem állítjuk (a repo-határ
   * saját őrrel véd), ezért opcionális.
   */ restrictToEndpoints: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].boolean().optional(),
    /** Sablonozható fejlécek minden hívásra (pl. X-Agent-Id, X-Connector-Call-Id). */ requestHeaders: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].record(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string(), __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string()).optional(),
    /** CRM acting user fallback, ha a runtime actingUser.email hiányzik (Ostorosbor). */ defaultActingUserEmail: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().email().optional(),
    githubRepositoryAccess: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$github$2d$repository$2d$access$2d$schema$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["githubRepositoryAccessSchema"].optional(),
    /** XML-alapú API adaptere (Számlázz.hu Agent, NAV Online Számla); hiányában JSON REST. */ protocol: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum(HTTP_API_PROTOCOLS).optional(),
    /** NAV Online Számla: a lekérdező adózó 8 jegyű törzsszáma. */ nav: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
        taxNumber: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().regex(/^\d{8}$/)
    }).optional(),
    /**
   * Privacy interface contract (spec §11). Hiányában a connector működik, de a
   * platform alacsonyabb privacy capability-t jelez (UI + audit).
   */ privacy: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["privacyCapabilityDeclarationSchema"].optional(),
    /**
   * Mezőszintű privacy metadata (spec §7). `privacy: tokenize` csak string
   * mezőre érvényes — numerikus/dátum mentéskor elbukik (R6).
   */ fields: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["connectorFieldsPrivacySchema"].optional(),
    /**
   * A forrás által definiált entitástípus-névtér (forrás-szerződés §5.1, issue #320).
   * A katalógus (`GET /privacy/catalog`) ugyanezzel a kulccsal érkezik, ezért a
   * bemásolt/importált katalógus itt VÁLTOZATLANUL átmegy — enélkül a Zod némán
   * eldobná, és a futásidő az öt alapértelmezett típusra esne vissza (`reversible`
   * invariáns kikapcsolva, forrás-egyedi típusok elveszve).
   */ entity_types: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["privacyEntityTypesSchema"].optional(),
    /**
   * Mi történjen a katalógusban NEM szereplő mezőkkel (forrás-szerződés §6.1).
   * Hiányában `pass` — a jelöletlen mező érintetlenül megy a modellhez.
   */ unlisted_default: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PRIVACY_UNLISTED_DEFAULTS"]).optional(),
    /** A forrás katalógusverziója (monoton nő); a platform csak auditál vele. */ catalog_version: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().int().positive().optional(),
    provenance: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].object({
        sourceHash: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
        extractedAt: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
        templateId: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
        templateKey: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional(),
        templateVersion: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].number().int().positive().optional(),
        templateOrigin: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].enum([
            'builtin',
            'custom'
        ]).optional(),
        materializedAt: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$zod$2f$v4$2f$classic$2f$external$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__$2a$__as__z$3e$__["z"].string().optional()
    }).optional()
});
const connectorConfigSchema = connectorConfigObjectSchema.superRefine((cfg, ctx)=>{
    if (!cfg.fields) return;
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["refineTokenizeReversibility"])(cfg.fields, (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["readConnectorEntityTypes"])(cfg), ctx, [
        'fields'
    ]);
});
class ConnectorConfigParseError extends Error {
    issues;
    constructor(message, issues){
        super(message), this.issues = issues;
        this.name = 'ConnectorConfigParseError';
    }
}
/**
 * Az `access` jelölést a metódusból normalizáljuk: minden mutáló metódus
 * `write`, ettől eltérő bemenetet felülírunk (a draft nem tüntethet el egy
 * write-tool figyelmeztetést egy téves `read` jelöléssel). Ez determinisztikus,
 * nem LLM-döntés.
 */ function formatConnectorConfigParseMessage(issues) {
    const first = issues[0];
    if (!first) return 'A connector-config séma érvénytelen.';
    const path = first.path.length > 0 ? `${first.path.map(String).join('.')}: ` : '';
    return `${path}${first.message}`;
}
function normalizeConnectorConfig(input) {
    const parsed = connectorConfigSchema.safeParse(input);
    if (!parsed.success) {
        throw new ConnectorConfigParseError(formatConnectorConfigParseMessage(parsed.error.issues), parsed.error.issues);
    }
    const cfg = parsed.data;
    return {
        ...cfg,
        proposedTools: cfg.proposedTools.map((t)=>({
                ...t,
                access: WRITE_METHODS.has(t.method) ? 'write' : t.access
            }))
    };
}
}),
"[project]/src/domain/connector-self-update/capability-set.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "capabilitySetToRuntimeEndpoints",
    ()=>capabilitySetToRuntimeEndpoints,
    "indexCapabilities",
    ()=>indexCapabilities,
    "opKey",
    ()=>opKey,
    "opKeyOf",
    ()=>opKeyOf,
    "parseCapabilitySet",
    ()=>parseCapabilitySet
]);
/**
 * Önfrissítő connector — capability-set reprezentáció (Dev-Spec §4).
 *
 * A "capability-set" a nyers spec-pillanatképből KIPARSE-OLT, strukturált képességlista:
 * a broker és a diff ezt érti (nem a nyers OpenAPI-t). A tárolt alak a meglévő
 * `ConnectorConfig` (a provisioning OpenAPI-extractor kimenete) — így a runtime
 * http-api-kliens és a sablon-katalógus reprezentációja változatlanul újrahasznált.
 *
 * Ez a modul TISZTA: nincs DB, nincs hálózat. A verzió `capability_set` JSON-je
 * ebből az alakból (`CapabilitySet`) áll elő, és ide is olvasható vissza.
 */ var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$provisioning$2f$connector$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/provisioning/connector-config.ts [app-rsc] (ecmascript)");
;
function opKey(method, path) {
    return `${String(method).toUpperCase()} ${path}`;
}
function opKeyOf(tool) {
    return opKey(tool.method, tool.path);
}
function indexCapabilities(set) {
    const index = new Map();
    for (const tool of set.proposedTools ?? []){
        const key = opKeyOf(tool);
        if (!index.has(key)) index.set(key, tool);
    }
    return index;
}
function parseCapabilitySet(value) {
    const parsed = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$provisioning$2f$connector$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["connectorConfigSchema"].safeParse(value);
    return parsed.success ? parsed.data : null;
}
function capabilitySetToRuntimeEndpoints(set) {
    return (set.proposedTools ?? []).map((tool)=>({
            method: tool.method,
            path: tool.path,
            access: tool.access,
            ...tool.description ? {
                description: tool.description
            } : {},
            ...tool.idempotent ? {
                idempotent: true
            } : {},
            ...tool.parameters ? {
                parameters: tool.parameters
            } : {},
            ...tool.pagination ? {
                pagination: tool.pagination
            } : {}
        }));
}
}),
"[project]/src/domain/connector-template/custom-template-seeds.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "GLOBAL_CUSTOM_CONNECTOR_TEMPLATES",
    ()=>GLOBAL_CUSTOM_CONNECTOR_TEMPLATES,
    "OSTOROSBOR_CRM_DEFAULT_INSTANCE_VALUES",
    ()=>OSTOROSBOR_CRM_DEFAULT_INSTANCE_VALUES,
    "OSTOROSBOR_CRM_REQUEST_HEADERS",
    ()=>OSTOROSBOR_CRM_REQUEST_HEADERS
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$github$2d$repository$2d$access$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector/github-repository-access.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/privacy/connector-privacy.ts [app-rsc] (ecmascript)");
;
;
const GOOGLE_USER_DELEGATED_OAUTH = {
    kind: 'user_delegated_oauth2',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    accountEmailField: 'email',
    offlineParams: {
        access_type: 'offline'
    },
    scopeTransform: 'none'
};
const GOOGLE_OAUTH_EGRESS_HOSTS = [
    'accounts.google.com',
    'oauth2.googleapis.com',
    'www.googleapis.com'
];
function googleOauthClientFields(secretAliasHint) {
    return [
        {
            name: 'clientId',
            label: 'OAuth client ID',
            type: 'string',
            required: true,
            target: 'auth.clientId'
        },
        {
            name: 'clientSecret',
            label: 'OAuth client secret',
            type: 'secret',
            required: true,
            secretAliasHint,
            target: 'auth.secretAliasSuggested'
        }
    ];
}
const OSTOROSBOR_CRM_DEFAULT_INSTANCE_VALUES = {
    crmHost: 'ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app'
};
const OSTOROSBOR_CRM_REQUEST_HEADERS = {
    'X-Agent-Id': '{{agent.id}}',
    'X-Acting-User': '{{actingUser.email}}',
    'X-Connector-Call-Id': '{{call.id}}'
};
const GLOBAL_CUSTOM_CONNECTOR_TEMPLATES = [
    {
        key: 'github',
        displayName: 'GitHub',
        connectorType: 'http_api',
        description: 'GitHub REST API connector fine-grained personal access tokennel vagy klasszikus PAT-tel.',
        activationHelp: `1. GitHubban nyisd meg a Settings -> Developer settings -> Personal access tokens oldalt.
2. Hozz létre egy Fine-grained personal access tokent, és válaszd ki a szükséges repository-kat.
3. Add meg legalább azokat a jogosultságokat, amelyek a kiválasztott toolokhoz kellenek:
- read-only hívásokhoz tipikusan repository metadata / issues read / pull requests read
- create_issue-hoz Issues write
- create_pull_request-höz Pull requests write és jellemzően Contents read
4. Másold ki a tokent egyszer, és itt add meg API kulcsként vagy secret-alias mögé mentve.
5. Ha szervezeti repository-t használsz, ellenőrizd, hogy a szervezeti policy engedi a PAT használatát.`,
        baseUrl: 'https://api.github.com',
        egressHosts: [
            'api.github.com'
        ],
        authMethods: [
            {
                kind: 'bearer'
            }
        ],
        scopeCatalog: [],
        endpoints: [
            {
                name: 'get_authenticated_user',
                method: 'GET',
                path: '/user',
                access: 'read',
                description: 'Read the authenticated GitHub user profile.',
                default: true
            },
            {
                name: 'list_user_repositories',
                method: 'GET',
                path: '/user/repos',
                access: 'read',
                description: 'List repositories visible to the authenticated user.',
                default: true
            },
            {
                name: 'get_repository',
                method: 'GET',
                path: '/repos/{owner}/{repo}',
                access: 'read',
                description: 'Read metadata for a repository.',
                default: true
            },
            {
                name: 'get_repository_tree',
                method: 'GET',
                path: '/repos/{owner}/{repo}/git/trees/{ref}',
                access: 'read',
                description: 'A repository teljes fájllistája EGY hívásban (ref = branch neve vagy commit SHA), recursive=1 query paraméterrel az alkönyvtárakkal együtt. Kódkérdésnél ezzel kezdj: ebből válaszd ki, melyik fájlt kell elolvasni — ne lépkedj könyvtáranként.',
                default: true
            },
            {
                name: 'get_file_contents',
                method: 'GET',
                path: '/repos/{owner}/{repo}/contents/{path}',
                access: 'read',
                description: 'Egy fájl tartalma, vagy könyvtár-útvonalon a könyvtár listája. Fájlnál a platform a base64 tartalmat UTF-8 szöveggé dekódolja (encoding: "utf-8"), tehát közvetlenül olvasható. Nem alapértelmezett ághoz: ?ref=<branch|sha>.',
                default: true
            },
            {
                name: 'list_issues',
                method: 'GET',
                path: '/repos/{owner}/{repo}/issues',
                access: 'read',
                description: 'List issues in a repository.',
                default: true
            },
            {
                name: 'create_issue',
                method: 'POST',
                path: '/repos/{owner}/{repo}/issues',
                access: 'write',
                description: 'Create an issue in a repository.',
                default: false
            },
            {
                name: 'list_pull_requests',
                method: 'GET',
                path: '/repos/{owner}/{repo}/pulls',
                access: 'read',
                description: 'List pull requests in a repository.',
                default: true
            },
            {
                name: 'create_pull_request',
                method: 'POST',
                path: '/repos/{owner}/{repo}/pulls',
                access: 'write',
                description: 'Create a pull request in a repository.',
                default: false
            },
            {
                name: 'list_commits',
                method: 'GET',
                path: '/repos/{owner}/{repo}/commits',
                access: 'read',
                description: 'List commits for a repository branch or revision range.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'repositoryAccess',
                label: 'Repository-hozzáférés (* vagy owner/repo lista)',
                type: 'string',
                required: true,
                validation: {
                    pattern: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$github$2d$repository$2d$access$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["GITHUB_REPOSITORY_LIST_PATTERN_SOURCE"]
                },
                target: 'github.repositoryAccess'
            },
            {
                name: 'personalAccessToken',
                label: 'GitHub personal access token',
                type: 'secret',
                required: true,
                secretAliasHint: 'github-personal-access-token',
                hiddenInProvisioning: true,
                target: 'auth.secretAliasSuggested'
            }
        ],
        rateLimit: {
            rps: 5,
            burst: 10
        }
    },
    {
        key: 'ostorosbor-crm-sales-delegated',
        displayName: 'Ostorosbor CRM - Sales delegated',
        connectorType: 'http_api',
        description: 'Ertekesito neveben futo CRM kapcsolat: ugyfeladatok olvasasa, erdeklodesek, teendok, interakciok, ajanlatstatusz es dokumentum-draft muveletek. A CRM nem kuld ugyfelnek uzenetet; a javaslatok HITL jovahagyasra kerulnek. A trace fejléceket (X-Agent-Id, X-Acting-User, X-Connector-Call-Id) és az író hívások Idempotency-Key-jét a platform automatikusan küldi — a headers mezőt ehhez ne töltsd. A CRM nem enged közvetlen ügyfélnek küldést és nem támogat végleges DELETE műveletet a connectoron.',
        activationHelp: 'Az API kulcs generálásához az Ostoros CRM Platform integráció menüpontjában kell API kulcsot létrehoznod (Sales delegated profil), majd az itt megadott API kulcs mezőbe CSAK a nyers kulcsot írd be — a "Bearer " előtagot és az Authorization fejlécet a rendszer automatikusan hozzáadja, neked nem kell beírnod. A CRM host mezőbe a tényleges CRM szerver domainjét/portját add meg (a fejlesztői leírásban szereplő 0.0.0.0:8080 csak helyi teszt-placeholder). Az „Acting user e-mail” mezőbe olyan címet adj meg, amely a CRM-ben regisztrált és aktív felhasználó — a kulcsos teszt és az agent hívások ehhez kötődnek (X-Acting-User fejléc).',
        baseUrl: 'https://{crmHost}/api/connector/v1',
        egressHosts: [
            '{crmHost}'
        ],
        authMethods: [
            {
                kind: 'bearer'
            }
        ],
        requestHeaders: {
            ...OSTOROSBOR_CRM_REQUEST_HEADERS
        },
        scopeCatalog: [],
        privacy: {
            ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["OSTOROSBOR_CRM_PRIVACY_CAPABILITIES"]
        },
        fields: {
            ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["OSTOROSBOR_CRM_PRIVACY_FIELDS"]
        },
        endpoints: [
            {
                name: 'list_accounts',
                method: 'GET',
                path: '/accounts',
                access: 'read',
                description: 'Ugyfellista lekerdezese.',
                default: true
            },
            {
                name: 'get_account',
                method: 'GET',
                path: '/accounts/{id}',
                access: 'read',
                description: 'Account 360 lekerdezese.',
                default: true
            },
            {
                name: 'soft_delete_account',
                method: 'POST',
                path: '/accounts/{id}/soft-delete',
                access: 'write',
                description: 'Ugyfel visszafordithato torlese.',
                default: false
            },
            {
                name: 'list_quotes',
                method: 'GET',
                path: '/quotes',
                access: 'read',
                description: 'Ajanlatlista lekerdezese.',
                default: true
            },
            {
                name: 'update_quote_status',
                method: 'PATCH',
                path: '/quotes/{id}/status',
                access: 'write',
                description: 'Ajanlat statusz valtasa.',
                default: false
            },
            {
                name: 'list_inquiries',
                method: 'GET',
                path: '/inquiries',
                access: 'read',
                description: 'Bejovo erdeklodesek lekerdezese.',
                default: true
            },
            {
                name: 'create_inquiry',
                method: 'POST',
                path: '/inquiries',
                access: 'write',
                description: 'Uj bejovo erdeklodes rogzitese.',
                default: false
            },
            {
                name: 'create_task',
                method: 'POST',
                path: '/tasks',
                access: 'write',
                description: 'Follow-up teendo letrehozasa.',
                default: false
            },
            {
                name: 'list_interactions',
                method: 'GET',
                path: '/interactions',
                access: 'read',
                description: 'Interakciok lekerdezese.',
                default: true
            },
            {
                name: 'create_interaction',
                method: 'POST',
                path: '/interactions',
                access: 'write',
                description: 'Email, hivas, meeting vagy chat interakcio naplozasa.',
                default: false
            },
            {
                name: 'list_documents',
                method: 'GET',
                path: '/documents',
                access: 'read',
                description: 'Dokumentumlista lekerdezese.',
                default: true
            },
            {
                name: 'get_document',
                method: 'GET',
                path: '/documents/{id}',
                access: 'read',
                description: 'Dokumentum metaadat es signed download URL.',
                default: true
            },
            {
                name: 'create_document',
                method: 'POST',
                path: '/documents',
                access: 'write',
                description: 'Uj dokumentum-draft letrehozasa.',
                default: false
            },
            {
                name: 'create_document_version',
                method: 'POST',
                path: '/documents/{id}/versions',
                access: 'write',
                description: 'Uj dokumentum-draft verzio letrehozasa.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'crmHost',
                label: 'CRM szerver host (domain vagy IP, port opcionálisan, pl. crm.ostorosbor.hu:8080)',
                type: 'string',
                required: true,
                validation: {
                    format: 'host'
                },
                target: 'egressHosts'
            },
            {
                name: 'actingUserEmail',
                label: 'Acting user e-mail (CRM-ben regisztrált, aktív felhasználó — X-Acting-User fejléc)',
                type: 'string',
                required: true,
                target: 'defaultActingUserEmail'
            },
            {
                name: 'apiKey',
                label: 'API kulcs (a CRM integrációnál generált nyers kulcs — a "Bearer " előtagot a rendszer adja hozzá)',
                type: 'secret',
                required: true,
                secretAliasHint: 'ostorosbor-crm-sales-delegated-api-key',
                target: 'auth.secretAliasSuggested'
            }
        ]
    },
    {
        key: 'ostorosbor-crm-service-insight',
        displayName: 'Ostorosbor CRM - Service insight',
        connectorType: 'http_api',
        description: 'Service/monitoring kapcsolat: CRM adatok olvasasa, account agent mezok frissitese, insightok es heti osszefoglalo. Nem ertekesitoi muveletekre, hanem belso elemzesre es agent javaslatokra valo. A trace fejléceket (X-Agent-Id, X-Acting-User, X-Connector-Call-Id) és az író hívások Idempotency-Key-jét a platform automatikusan küldi — a headers mezőt ehhez ne töltsd. A CRM nem enged közvetlen ügyfélnek küldést és nem támogat végleges DELETE műveletet a connectoron.',
        activationHelp: 'Az API kulcs generálásához az Ostoros CRM Platform integráció menüpontjában kell API kulcsot létrehoznod (Service insight profil), majd az itt megadott API kulcs mezőbe CSAK a nyers kulcsot írd be — a "Bearer " előtagot és az Authorization fejlécet a rendszer automatikusan hozzáadja, neked nem kell beírnod. A CRM host mezőbe a tényleges CRM szerver domainjét/portját add meg (a fejlesztői leírásban szereplő 0.0.0.0:8080 csak helyi teszt-placeholder). Az „Acting user e-mail” mezőbe olyan címet adj meg, amely a CRM-ben regisztrált és aktív felhasználó — a kulcsos teszt és az agent hívások ehhez kötődnek (X-Acting-User fejléc).',
        baseUrl: 'https://{crmHost}/api/connector/v1',
        egressHosts: [
            '{crmHost}'
        ],
        authMethods: [
            {
                kind: 'bearer'
            }
        ],
        requestHeaders: {
            ...OSTOROSBOR_CRM_REQUEST_HEADERS
        },
        scopeCatalog: [],
        privacy: {
            ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["OSTOROSBOR_CRM_PRIVACY_CAPABILITIES"]
        },
        fields: {
            ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["OSTOROSBOR_CRM_PRIVACY_FIELDS"]
        },
        endpoints: [
            {
                name: 'list_accounts',
                method: 'GET',
                path: '/accounts',
                access: 'read',
                description: 'Ugyfellista lekerdezese.',
                default: true
            },
            {
                name: 'get_account',
                method: 'GET',
                path: '/accounts/{id}',
                access: 'read',
                description: 'Account 360 lekerdezese.',
                default: true
            },
            {
                name: 'update_account_agent_fields',
                method: 'PATCH',
                path: '/accounts/{id}/agent-fields',
                access: 'write',
                description: 'Health score, indoklas es next-best-action frissitese.',
                default: false
            },
            {
                name: 'list_quotes',
                method: 'GET',
                path: '/quotes',
                access: 'read',
                description: 'Ajanlatlista lekerdezese.',
                default: true
            },
            {
                name: 'list_inquiries',
                method: 'GET',
                path: '/inquiries',
                access: 'read',
                description: 'Erdeklodeslista lekerdezese.',
                default: true
            },
            {
                name: 'list_documents',
                method: 'GET',
                path: '/documents',
                access: 'read',
                description: 'Dokumentumlista lekerdezese.',
                default: true
            },
            {
                name: 'get_document',
                method: 'GET',
                path: '/documents/{id}',
                access: 'read',
                description: 'Dokumentum metaadat es signed download URL.',
                default: true
            },
            {
                name: 'list_insights',
                method: 'GET',
                path: '/insights',
                access: 'read',
                description: 'CRM analitika lekerdezese.',
                default: true
            },
            {
                name: 'query_report',
                method: 'POST',
                path: '/reports/query',
                access: 'read',
                risk: 'read',
                description: 'Riportlekérdezés (nem módosít). Kötelező: period.from + period.to (YYYY-MM-DD, inkluzív); plusz preset VAGY dataset+measures. Példa: {"preset":"turnover","period":{"from":"2026-01-01","to":"2026-06-30"}}',
                default: true
            },
            {
                name: 'export_report',
                method: 'POST',
                path: '/reports/exports',
                access: 'read',
                risk: 'read',
                description: 'Riportexport (nem módosít). Ugyanaz a body, mint /reports/query, plusz format: "csv"|"xlsx".',
                default: true
            },
            {
                name: 'update_insights_nl_summary',
                method: 'PUT',
                path: '/insights/nl-summary',
                access: 'write',
                description: 'Heti termeszetes nyelvu osszefoglalo irasa.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'crmHost',
                label: 'CRM szerver host (domain vagy IP, port opcionálisan, pl. crm.ostorosbor.hu:8080)',
                type: 'string',
                required: true,
                validation: {
                    format: 'host'
                },
                target: 'egressHosts'
            },
            {
                name: 'actingUserEmail',
                label: 'Acting user e-mail (CRM-ben regisztrált, aktív felhasználó — X-Acting-User fejléc)',
                type: 'string',
                required: true,
                target: 'defaultActingUserEmail'
            },
            {
                name: 'apiKey',
                label: 'API kulcs (a CRM integrációnál generált nyers kulcs — a "Bearer " előtagot a rendszer adja hozzá)',
                type: 'secret',
                required: true,
                secretAliasHint: 'ostorosbor-crm-service-insight-api-key',
                target: 'auth.secretAliasSuggested'
            }
        ]
    },
    {
        key: 'google-search-console',
        displayName: 'Google Search Console',
        connectorType: 'http_api',
        description: 'Google Search Console API (searchconsole.googleapis.com): Search Analytics, verified site-ek, sitemaps és URL Inspection. Delegált felhasználói OAuth.',
        activationHelp: `1. Nyisd meg a Google Cloud Console-t: https://console.cloud.google.com/
2. Válaszd ki vagy hozd létre a projektet.
3. APIs & Services → Library → engedélyezd a „Google Search Console API” szolgáltatást.
4. APIs & Services → OAuth consent screen → állítsd be (Internal vagy External; teszthez add hozzá a tesztfelhasználókat). Vedd fel a webmasters.readonly vagy webmasters scope-ot.
5. APIs & Services → Credentials → OAuth client ID, típus: Web application; redirect URI = platform …/api/connectors/oauth/callback.
6. Client ID + secret: Platform · Beállítások → Google API OAuth (egy app az Analytics / Search Console / Ads / Calendar / Sheets sablonokhoz).
7. A hívott felhasználónak verified owner/user jog kell a Search Console property-n.
8. A siteUrl path-paramétert URL-kódolni kell: https://www.example.com/ → https%3A%2F%2Fwww.example.com%2F; domain-property: sc-domain:example.com.`,
        baseUrl: 'https://searchconsole.googleapis.com',
        egressHosts: [
            'searchconsole.googleapis.com',
            ...GOOGLE_OAUTH_EGRESS_HOSTS
        ],
        authMethods: [
            {
                ...GOOGLE_USER_DELEGATED_OAUTH
            }
        ],
        scopeCatalog: [
            {
                value: 'https://www.googleapis.com/auth/webmasters.readonly',
                label: 'Search Console csak olvasás',
                description: 'Verified site-ek, Search Analytics, sitemaps és URL Inspection olvasása.',
                default: true
            },
            {
                value: 'https://www.googleapis.com/auth/webmasters',
                label: 'Search Console olvasás + írás',
                description: 'Site hozzáadása/eltávolítása és sitemap beküldése/törlése is.',
                default: false
            }
        ],
        endpoints: [
            {
                name: 'list_sites',
                method: 'GET',
                path: '/webmasters/v3/sites',
                access: 'read',
                description: 'A felhasználó Search Console site-jainak listája (permissionLevel + siteUrl).',
                default: true
            },
            {
                name: 'get_site',
                method: 'GET',
                path: '/webmasters/v3/sites/{siteUrl}',
                access: 'read',
                description: 'Egy Search Console property adatai. siteUrl URL-kódolt, pl. https%3A%2F%2Fwww.example.com%2F vagy sc-domain:example.com.',
                default: true
            },
            {
                name: 'query_search_analytics',
                method: 'POST',
                path: '/webmasters/v3/sites/{siteUrl}/searchAnalytics/query',
                access: 'read',
                description: 'Search Analytics lekérdezés. Kötelező body: startDate, endDate (YYYY-MM-DD). Opcionális: dimensions (DATE, QUERY, PAGE, COUNTRY, DEVICE, SEARCH_APPEARANCE, HOUR), rowLimit (max 25000), startRow, type (WEB|IMAGE|VIDEO|NEWS|DISCOVER|GOOGLE_NEWS), dimensionFilterGroups. Példa: {"startDate":"2026-07-01","endDate":"2026-07-31","dimensions":["query","page"],"rowLimit":25}.',
                default: true
            },
            {
                name: 'list_sitemaps',
                method: 'GET',
                path: '/webmasters/v3/sites/{siteUrl}/sitemaps',
                access: 'read',
                description: 'A site-hoz beküldött sitemap-ek listája. Opcionális query: sitemapIndex.',
                default: true
            },
            {
                name: 'get_sitemap',
                method: 'GET',
                path: '/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}',
                access: 'read',
                description: 'Egy sitemap adatai. feedpath a sitemap URL-je, URL-kódolva (pl. https%3A%2F%2Fwww.example.com%2Fsitemap.xml).',
                default: false
            },
            {
                name: 'inspect_url_index',
                method: 'POST',
                path: '/v1/urlInspection/index:inspect',
                access: 'read',
                description: 'URL Inspection: indexelési állapot a Google indexben. Body: {"inspectionUrl":"https://www.example.com/page","siteUrl":"https://www.example.com/","languageCode":"hu-HU"}. A siteUrl megegyezik a Search Console property URL-jével (domain-property: sc-domain:example.com).',
                default: true
            },
            {
                name: 'add_site',
                method: 'PUT',
                path: '/webmasters/v3/sites/{siteUrl}',
                access: 'write',
                description: 'Site hozzáadása a felhasználó Search Console fiókjához. webmasters scope kell.',
                default: false
            },
            {
                name: 'delete_site',
                method: 'DELETE',
                path: '/webmasters/v3/sites/{siteUrl}',
                access: 'write',
                description: 'Site eltávolítása a felhasználó Search Console fiókjából. webmasters scope kell.',
                default: false
            },
            {
                name: 'submit_sitemap',
                method: 'PUT',
                path: '/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}',
                access: 'write',
                description: 'Sitemap beküldése. webmasters scope kell.',
                default: false
            },
            {
                name: 'delete_sitemap',
                method: 'DELETE',
                path: '/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}',
                access: 'write',
                description: 'Sitemap törlése a Sitemaps jelentésből (a Google ettől még crawlolhatja). webmasters scope kell.',
                default: false
            }
        ],
        instanceFields: [],
        rateLimit: {
            rps: 5,
            burst: 10
        }
    },
    {
        key: 'google-analytics',
        displayName: 'Google Analytics',
        connectorType: 'http_api',
        description: 'Google Analytics Data API v1beta (GA4): runReport, valós idejű és pivot riportok, property metadata. Delegált felhasználói OAuth.',
        activationHelp: `1. Nyisd meg a Google Cloud Console-t: https://console.cloud.google.com/
2. Válaszd ki vagy hozd létre a projektet.
3. APIs & Services → Library → engedélyezd a „Google Analytics Data API” szolgáltatást.
4. APIs & Services → OAuth consent screen → állítsd be, és vedd fel az analytics.readonly (vagy analytics) scope-ot.
5. APIs & Services → Credentials → OAuth client ID, típus: Web application; redirect URI = platform …/api/connectors/oauth/callback.
6. Client ID + secret: Platform · Beállítások → Google API OAuth.
7. A csatlakoztatott Google-fióknak legalább Viewer joga kell a GA4 property-n.
9. A property ID a GA Admin → Property settings oldalon látható (szám, pl. 123456789). A path-ben: /v1beta/properties/{propertyId}:runReport — a properties/ előtagot a path már tartalmazza, csak a számot add meg.`,
        baseUrl: 'https://analyticsdata.googleapis.com',
        egressHosts: [
            'analyticsdata.googleapis.com',
            ...GOOGLE_OAUTH_EGRESS_HOSTS
        ],
        authMethods: [
            {
                ...GOOGLE_USER_DELEGATED_OAUTH
            }
        ],
        scopeCatalog: [
            {
                value: 'https://www.googleapis.com/auth/analytics.readonly',
                label: 'Analytics csak olvasás',
                description: 'GA4 riportok és property metadata olvasása.',
                default: true
            },
            {
                value: 'https://www.googleapis.com/auth/analytics',
                label: 'Analytics teljes hozzáférés',
                description: 'Szélesebb Analytics-hozzáférés. Csak ha a readonly scope nem elég.',
                default: false
            }
        ],
        endpoints: [
            {
                name: 'run_report',
                method: 'POST',
                path: '/v1beta/properties/{propertyId}:runReport',
                access: 'read',
                description: 'GA4 riport. propertyId a numerikus GA4 property azonosító. Body: dimensions, metrics, dateRanges. Példa: {"dateRanges":[{"startDate":"28daysAgo","endDate":"yesterday"}],"dimensions":[{"name":"date"},{"name":"sessionDefaultChannelGroup"}],"metrics":[{"name":"activeUsers"},{"name":"sessions"},{"name":"bounceRate"}],"limit":"100"}. Dimenzió/metrika nevek: get_metadata.',
                default: true
            },
            {
                name: 'run_realtime_report',
                method: 'POST',
                path: '/v1beta/properties/{propertyId}:runRealtimeReport',
                access: 'read',
                description: 'Valós idejű (kb. az utolsó 30 perc) GA4 riport. Body: dimensions + metrics, dateRanges nélkül. Példa: {"dimensions":[{"name":"unifiedScreenName"}],"metrics":[{"name":"activeUsers"}]}.',
                default: true
            },
            {
                name: 'run_pivot_report',
                method: 'POST',
                path: '/v1beta/properties/{propertyId}:runPivotReport',
                access: 'read',
                description: 'Pivot GA4 riport. Body: dimensions, metrics, dateRanges és pivots (fieldNames, limit).',
                default: false
            },
            {
                name: 'batch_run_reports',
                method: 'POST',
                path: '/v1beta/properties/{propertyId}:batchRunReports',
                access: 'read',
                description: 'Több runReport egy hívásban. Body: {"requests":[ /* RunReportRequest objektumok */ ]}.',
                default: false
            },
            {
                name: 'get_metadata',
                method: 'GET',
                path: '/v1beta/properties/{propertyId}/metadata',
                access: 'read',
                description: 'A property elérhető dimenziói és metrikái (név, UI-név, típus). Riportépítés előtt ezzel ellenőrizd a mezőneveket.',
                default: true
            },
            {
                name: 'check_compatibility',
                method: 'POST',
                path: '/v1beta/properties/{propertyId}:checkCompatibility',
                access: 'read',
                description: 'Ellenőrzi, hogy a kért dimenziók és metrikák kompatibilisek-e egy riportban. Body ugyanaz a dimensions/metrics alak, mint runReport.',
                default: false
            }
        ],
        instanceFields: [],
        rateLimit: {
            rps: 5,
            burst: 10
        }
    },
    {
        key: 'google-ads',
        displayName: 'Google Ads',
        connectorType: 'http_api',
        description: 'Google Ads API REST v25: fióklista, GAQL search/searchStream és campaign/ad group/ad mutate. Delegált OAuth + developer-token fejléc.',
        activationHelp: `1. Kell egy Google Ads manager (MCC) fiók. A developer token az API Centerben van: https://ads.google.com/aw/apicenter
2. Teszt-hozzáférésű token csak tesztfiókra megy; éles fiókhoz Basic/Standard jóváhagyás kell.
3. Nyisd meg a Google Cloud Console-t: https://console.cloud.google.com/
4. APIs & Services → Library → engedélyezd a „Google Ads API” szolgáltatást.
5. OAuth consent screen + Credentials → OAuth client ID, típus: Web application; redirect URI = platform …/api/connectors/oauth/callback.
6. Client ID + secret: Platform · Beállítások → Google API OAuth.
7. Aktiváláskor add meg: developer token (Google Ads API Center). MCC alatti kliensfiókhoz opcionálisan login-customer-id (kötőjel nélkül).
8. A customerId path-paraméter mindig kötőjel nélküli 10 jegyű szám.
9. Olvasáshoz a googleAds:search GAQL-t használd; a mutate végpontok írnak.`,
        baseUrl: 'https://googleads.googleapis.com',
        egressHosts: [
            'googleads.googleapis.com',
            ...GOOGLE_OAUTH_EGRESS_HOSTS
        ],
        authMethods: [
            {
                ...GOOGLE_USER_DELEGATED_OAUTH
            }
        ],
        scopeCatalog: [
            {
                value: 'https://www.googleapis.com/auth/adwords',
                label: 'Google Ads',
                description: 'Google Ads fiókok kezelése a Google Ads API-n (egyetlen hivatalos Ads-scope).',
                default: true
            }
        ],
        endpoints: [
            {
                name: 'list_accessible_customers',
                method: 'GET',
                path: '/v25/customers:listAccessibleCustomers',
                access: 'read',
                description: 'Az OAuth-tokenhez közvetlenül hozzáférhető Google Ads customer resource name-ek. Ehhez a híváshoz nem kell login-customer-id. Válasz: customers/1234567890.',
                default: true
            },
            {
                name: 'get_customer',
                method: 'GET',
                path: '/v25/customers/{customerId}',
                access: 'read',
                description: 'Egy Google Ads fiók erőforrása. customerId kötőjel nélkül. Query: fieldMask (pl. customer.id,customer.descriptive_name,customer.currency_code,customer.time_zone).',
                default: true
            },
            {
                name: 'search',
                method: 'POST',
                path: '/v25/customers/{customerId}/googleAds:search',
                access: 'read',
                description: 'Google Ads Query Language (GAQL) keresés, lapozható JSON válasz. Body: {"query":"SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS"}. További resource-ok: ad_group, ad_group_ad, keyword_view, customer, geographic_view.',
                default: true
            },
            {
                name: 'search_stream',
                method: 'POST',
                path: '/v25/customers/{customerId}/googleAds:searchStream',
                access: 'read',
                description: 'GAQL keresés folyamatos (searchStream) válasszal, nagy eredményhalmazhoz. Body ugyanaz, mint search: {"query":"..."}.',
                default: false
            },
            {
                name: 'mutate_campaigns',
                method: 'POST',
                path: '/v25/customers/{customerId}/campaigns:mutate',
                access: 'write',
                description: 'Kampány create/update/remove. Body: {"operations":[{"create":{"name":"...","advertisingChannelType":"SEARCH","status":"PAUSED","campaignBudget":"customers/{customerId}/campaignBudgets/{budgetId}"}}]}. Update-nél updateMask kell.',
                default: false
            },
            {
                name: 'mutate_ad_groups',
                method: 'POST',
                path: '/v25/customers/{customerId}/adGroups:mutate',
                access: 'write',
                description: 'Hirdetéscsoport create/update/remove. Body: {"operations":[{"create":{"name":"...","campaign":"customers/{customerId}/campaigns/{campaignId}","status":"PAUSED"}}]}.',
                default: false
            },
            {
                name: 'mutate_ad_group_ads',
                method: 'POST',
                path: '/v25/customers/{customerId}/adGroupAds:mutate',
                access: 'write',
                description: 'Hirdetés (ad group ad) create/update/remove. Body: {"operations":[{"create":{"adGroup":"customers/{customerId}/adGroups/{adGroupId}","status":"PAUSED","ad":{}}}]}.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'developerToken',
                label: 'Google Ads developer token (API Center)',
                type: 'string',
                required: true,
                target: 'requestHeaders.developer-token'
            },
            {
                name: 'loginCustomerId',
                label: 'Login-customer-id (MCC, kötőjel nélkül — opcionális)',
                type: 'string',
                required: false,
                target: 'requestHeaders.login-customer-id'
            }
        ],
        rateLimit: {
            rps: 2,
            burst: 5
        }
    },
    {
        key: 'meta-ads',
        displayName: 'Meta Ads',
        connectorType: 'http_api',
        description: 'Meta Marketing API (Graph API v26.0): hirdetési fiókok, kampányok, ad setek, hirdetések és Insights. System user vagy hosszú életű user access token (bearer).',
        activationHelp: `Egyetlen titok kell: a Meta access token. A Business Manager magyar UI-ján ez „Kód” néven jelenik meg (EAA… / EABA… kezdetű hosszú string). Nincs külön client secret ennél a sablonnál.

Hol add meg:
• Sablon/draft lépés: a „Meta Marketing API access token” mezőt HAGYD a meta-ads-access-token alias-néven — ide NE másold a kódot.
• Sandbox-teszt: tokentelen elérhetőségi próba (nem a te kulcsodat küldi).
• Aktiválás: az „API kulcs” mezőbe illeszd a nyers Kódot. A „Bearer ” előtagot NE írd elé.

Token létrehozása:
1. developers.facebook.com/apps → Business típusú app, Marketing API termék.
2. Business Manager → Rendszerfelhasználók → system user → hirdetési fiók hozzárendelése → token/kód generálása. Jogosultságok: ads_read (íráshoz ads_management, business_management). Lejárat: soha (system user) vagy 60 nap.
3. Alternatíva: Graph API Explorer user token, majd Access Token Debuggerrel hosszú életűre cserélve.

Az adAccountId path-paraméter a numerikus fiókazonosító, act_ nélkül. Éles, idegen fiókra App Review kell; fejlesztésben az app admin/teszt user tokenje elég.`,
        baseUrl: 'https://graph.facebook.com/v26.0',
        egressHosts: [
            'graph.facebook.com'
        ],
        authMethods: [
            {
                kind: 'bearer'
            }
        ],
        scopeCatalog: [],
        endpoints: [
            {
                name: 'get_me',
                method: 'GET',
                path: '/me',
                access: 'read',
                description: 'A tokenhez tartozó user vagy system user. Query: fields=id,name. Kapcsolatellenőrzéshez használd.',
                default: true
            },
            {
                name: 'list_ad_accounts',
                method: 'GET',
                path: '/me/adaccounts',
                access: 'read',
                description: 'A tokenhez látható hirdetési fiókok. Query: fields=id,account_id,name,account_status,currency,timezone_name,amount_spent,balance&limit=100.',
                default: true
            },
            {
                name: 'list_businesses',
                method: 'GET',
                path: '/me/businesses',
                access: 'read',
                description: 'A tokenhez tartozó Business Manager fiókok. Query: fields=id,name.',
                default: true
            },
            {
                name: 'get_ad_account',
                method: 'GET',
                path: '/act_{adAccountId}',
                access: 'read',
                description: 'Egy hirdetési fiók. adAccountId numerikus, act_ nélkül. Query: fields=id,account_id,name,account_status,currency,timezone_name,amount_spent,balance,spend_cap.',
                default: true
            },
            {
                name: 'list_campaigns',
                method: 'GET',
                path: '/act_{adAccountId}/campaigns',
                access: 'read',
                description: 'Kampányok. Query: fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time&effective_status=["ACTIVE","PAUSED"]&limit=100.',
                default: true
            },
            {
                name: 'get_campaign',
                method: 'GET',
                path: '/{campaignId}',
                access: 'read',
                description: 'Egy kampány. Query: fields=id,name,status,effective_status,objective,account_id.',
                default: true
            },
            {
                name: 'list_adsets',
                method: 'GET',
                path: '/act_{adAccountId}/adsets',
                access: 'read',
                description: 'Ad setek. Query: fields=id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting&limit=100.',
                default: true
            },
            {
                name: 'list_ads',
                method: 'GET',
                path: '/act_{adAccountId}/ads',
                access: 'read',
                description: 'Hirdetések. Query: fields=id,name,status,effective_status,adset_id,campaign_id,creative&limit=100.',
                default: true
            },
            {
                name: 'get_account_insights',
                method: 'GET',
                path: '/act_{adAccountId}/insights',
                access: 'read',
                description: 'Fiókszintű Insights. Query példa: fields=campaign_name,impressions,clicks,spend,cpc,ctr,actions,reach&level=campaign&date_preset=last_7d. date_preset helyett time_range={"since":"2026-07-01","until":"2026-07-31"}.',
                default: true
            },
            {
                name: 'get_campaign_insights',
                method: 'GET',
                path: '/{campaignId}/insights',
                access: 'read',
                description: 'Kampányszintű Insights. Query: fields=impressions,clicks,spend,cpc,ctr,actions&date_preset=last_7d.',
                default: true
            },
            {
                name: 'get_adset_insights',
                method: 'GET',
                path: '/{adsetId}/insights',
                access: 'read',
                description: 'Ad set Insights. Query: fields=impressions,clicks,spend,cpc,ctr&date_preset=last_7d.',
                default: false
            },
            {
                name: 'get_ad_insights',
                method: 'GET',
                path: '/{adId}/insights',
                access: 'read',
                description: 'Hirdetés Insights. Query: fields=impressions,clicks,spend,cpc,ctr,actions&date_preset=last_7d.',
                default: false
            },
            {
                name: 'list_custom_audiences',
                method: 'GET',
                path: '/act_{adAccountId}/customaudiences',
                access: 'read',
                description: 'Egyéni közönségek. Query: fields=id,name,subtype,approximate_count&limit=100.',
                default: false
            },
            {
                name: 'create_campaign',
                method: 'POST',
                path: '/act_{adAccountId}/campaigns',
                access: 'write',
                description: 'Kampány létrehozása. Body (form vagy JSON): name, objective (pl. OUTCOME_TRAFFIC, OUTCOME_LEADS, OUTCOME_SALES), status (ACTIVE|PAUSED), special_ad_categories (tömb, üresen [] ha nincs). ads_management kell.',
                default: false
            },
            {
                name: 'update_campaign',
                method: 'POST',
                path: '/{campaignId}',
                access: 'write',
                description: 'Kampány módosítása (Graph API POST az objektum-ID-re). Body: name, status (ACTIVE|PAUSED|DELETED). ads_management kell.',
                default: false
            },
            {
                name: 'create_adset',
                method: 'POST',
                path: '/act_{adAccountId}/adsets',
                access: 'write',
                description: 'Ad set létrehozása. Body: name, campaign_id, daily_budget vagy lifetime_budget (centes egység), billing_event, optimization_goal, targeting, start_time, status. ads_management kell.',
                default: false
            },
            {
                name: 'create_ad',
                method: 'POST',
                path: '/act_{adAccountId}/ads',
                access: 'write',
                description: 'Hirdetés létrehozása. Body: name, adset_id, creative (pl. {"creative_id":"..."}), status (ACTIVE|PAUSED). ads_management kell.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'accessToken',
                label: 'Meta Marketing API access token (system user vagy hosszú életű user token)',
                type: 'secret',
                required: true,
                secretAliasHint: 'meta-ads-access-token',
                target: 'auth.secretAliasSuggested'
            }
        ],
        rateLimit: {
            rps: 2,
            burst: 5
        }
    },
    {
        key: 'google-calendar',
        displayName: 'Google Calendar',
        connectorType: 'http_api',
        description: 'Google Calendar API v3: naptárak, események keresése, szabad időpont, esemény létrehozása és módosítása. Delegált felhasználói OAuth.',
        activationHelp: `Nincs szükség saját Google Cloud-projektre — a platform Google API OAuth appját használja. Lépések sorban:
1. Platform · Beállítások → Google API OAuth: ellenőrizd, hogy be van-e állítva (Client ID + secret). Ha nincs, előbb azt kérd a platform-üzemeltetőtől — enélkül nem megy tovább.
2. A Google Cloud-projektben legyen engedélyezve a „Google Calendar API” (ezt is a platform-üzemeltető végzi, egyszer kell).
3. Scope-ok: a „Csak olvasás” elég kereséshez és szabad időpontokhoz. Ha az agent időpontot is foglalhat, pipáld be MELLÉ az „Eseményírás” scope-ot, és a végpontok közül a create_event / update_event (és ha kell, delete_event) sort is.
4. Aktiválás után minden felhasználó a saját Google-fiókjával köti be a naptárát (Kapcsolt fiókok) — az agent mindig az ő naptárát látja.
5. Tipp: a saját naptár azonosítója primary; más naptárét a list_calendars adja meg.`,
        baseUrl: 'https://www.googleapis.com',
        egressHosts: [
            'www.googleapis.com',
            ...GOOGLE_OAUTH_EGRESS_HOSTS
        ],
        authMethods: [
            {
                ...GOOGLE_USER_DELEGATED_OAUTH
            }
        ],
        scopeCatalog: [
            {
                value: 'https://www.googleapis.com/auth/calendar.readonly',
                label: 'Csak olvasás',
                description: 'Naptárak, események és szabad/foglalt időpontok olvasása. Kezdd ezzel.',
                default: true
            },
            {
                value: 'https://www.googleapis.com/auth/calendar.events',
                label: 'Eseményírás',
                description: 'Események létrehozása, módosítása, törlése. A „Csak olvasás” MELLÉ pipáld be — önmagában nem ad naptárlistát és szabad/foglalt lekérdezést.',
                default: false
            },
            {
                value: 'https://www.googleapis.com/auth/calendar',
                label: 'Teljes naptár-hozzáférés',
                description: 'Naptárlista-kezelés is. Csak ha a readonly/event scope nem elég.',
                default: false
            }
        ],
        endpoints: [
            {
                name: 'list_calendars',
                method: 'GET',
                path: '/calendar/v3/users/me/calendarList',
                access: 'read',
                description: 'A felhasználó naptárainak listája (id, summary, timeZone). Ezzel kezdj: innen jön a calendarId.',
                default: true
            },
            {
                name: 'list_events',
                method: 'GET',
                path: '/calendar/v3/calendars/{calendarId}/events',
                access: 'read',
                description: 'Események listázása. calendarId = primary vagy a list_calendars-ból. Query: timeMin, timeMax (RFC3339, pl. 2026-09-28T00:00:00+02:00), q (keresőkifejezés), singleEvents=true, orderBy=startTime.',
                default: true
            },
            {
                name: 'get_event',
                method: 'GET',
                path: '/calendar/v3/calendars/{calendarId}/events/{eventId}',
                access: 'read',
                description: 'Egy esemény részletei (mikor, hol, kik a résztvevők).',
                default: true
            },
            {
                name: 'query_freebusy',
                method: 'POST',
                path: '/calendar/v3/freeBusy',
                access: 'read',
                description: 'Szabad/foglalt időpontok. Body: {"timeMin":"...","timeMax":"...","items":[{"id":"primary"}]}. Időpont-kereséshez használd.',
                default: true
            },
            {
                name: 'create_event',
                method: 'POST',
                path: '/calendar/v3/calendars/{calendarId}/events',
                access: 'write',
                description: 'Esemény létrehozása. Body: {"summary":"Megbeszélés","start":{"dateTime":"2026-09-29T10:00:00+02:00"},"end":{"dateTime":"2026-09-29T11:00:00+02:00"},"attendees":[{"email":"partner@example.hu"}]}. calendar.events scope kell.',
                default: false
            },
            {
                name: 'update_event',
                method: 'PATCH',
                path: '/calendar/v3/calendars/{calendarId}/events/{eventId}',
                access: 'write',
                description: 'Esemény módosítása (időpont, résztvevők, leírás). Csak a változó mezőket küldd. calendar.events scope kell.',
                default: false
            },
            {
                name: 'delete_event',
                method: 'DELETE',
                path: '/calendar/v3/calendars/{calendarId}/events/{eventId}',
                access: 'write',
                description: 'Esemény törlése. Végleges — csak emberi jóváhagyással. calendar.events scope kell.',
                default: false
            }
        ],
        instanceFields: [],
        rateLimit: {
            rps: 5,
            burst: 10
        }
    },
    {
        key: 'google-sheets',
        displayName: 'Google Sheets',
        connectorType: 'http_api',
        description: 'Google Sheets API v4: táblázatok olvasása, sorok keresése, hozzáadása és módosítása. Delegált felhasználói OAuth.',
        activationHelp: `Nincs szükség saját Google Cloud-projektre — a platform Google API OAuth appját használja. Lépések sorban:
1. Platform · Beállítások → Google API OAuth: ellenőrizd, hogy be van-e állítva. Ha nincs, előbb azt kérd a platform-üzemeltetőtől.
2. A Google Cloud-projektben legyen engedélyezve a „Google Sheets API” (egyszeri platform-üzemeltetői lépés).
3. Scope-ok: a „Csak olvasás” elég riportokhoz és kereséshez. Sorok írásához válaszd a „Teljes írás” scope-ot, és a végpontok közül az append_values / update_values sort is pipáld be.
4. Aktiválás után minden felhasználó a saját Google-fiókjával köti be (Kapcsolt fiókok) — az agent az ő táblázatait látja.
5. Tipp: a táblázat azonosítója (spreadsheetId) a Docs-URL középső része (/d/<spreadsheetId>/edit); előbb olvasd ki a lap nevét, utána írj bele.`,
        baseUrl: 'https://sheets.googleapis.com',
        egressHosts: [
            'sheets.googleapis.com',
            ...GOOGLE_OAUTH_EGRESS_HOSTS
        ],
        authMethods: [
            {
                ...GOOGLE_USER_DELEGATED_OAUTH
            }
        ],
        scopeCatalog: [
            {
                value: 'https://www.googleapis.com/auth/spreadsheets.readonly',
                label: 'Csak olvasás',
                description: 'Táblázatok és cellatartományok olvasása. Kezdd ezzel.',
                default: true
            },
            {
                value: 'https://www.googleapis.com/auth/spreadsheets',
                label: 'Teljes írás',
                description: 'Sorok hozzáadása, módosítása és törlése is. Csak ha az agent írhat a táblázatba.',
                default: false
            }
        ],
        endpoints: [
            {
                name: 'get_spreadsheet',
                method: 'GET',
                path: '/v4/spreadsheets/{spreadsheetId}',
                access: 'read',
                description: 'Táblázat szerkezete (lapnevek, sor/oszlopszám). Ezzel kezdj: innen jön a lap neve a tartományokhoz. Query: includeGridData=false.',
                default: true
            },
            {
                name: 'get_values',
                method: 'GET',
                path: '/v4/spreadsheets/{spreadsheetId}/values/{range}',
                access: 'read',
                description: 'Cellatartomány olvasása. range példa: Munka1!A1:D100 (a lapnevet URL-kódold, ha szóközt tartalmaz).',
                default: true
            },
            {
                name: 'batch_get_values',
                method: 'GET',
                path: '/v4/spreadsheets/{spreadsheetId}/values:batchGet',
                access: 'read',
                description: 'Több tartomány egy hívásban. Query: ranges=Munka1!A1:A100&ranges=Munka1!C1:C100. Nagy táblánál ezt használd.',
                default: true
            },
            {
                name: 'append_values',
                method: 'POST',
                path: '/v4/spreadsheets/{spreadsheetId}/values/{range}:append',
                access: 'write',
                description: 'Sorok hozzáfűzése a tábla végére. Query: valueInputOption=USER_ENTERED. Body: {"values":[["név","email","123456"]]}. Teljes írás scope kell.',
                default: false
            },
            {
                name: 'update_values',
                method: 'PUT',
                path: '/v4/spreadsheets/{spreadsheetId}/values/{range}',
                access: 'write',
                description: 'Cellatartomány felülírása. Query: valueInputOption=USER_ENTERED. Body: {"values":[["új érték"]]}. Teljes írás scope kell.',
                default: false
            },
            {
                name: 'clear_values',
                method: 'POST',
                path: '/v4/spreadsheets/{spreadsheetId}/values/{range}:clear',
                access: 'write',
                description: 'Cellatartomány ürítése (a sorok megmaradnak). Teljes írás scope kell.',
                default: false
            }
        ],
        instanceFields: [],
        rateLimit: {
            rps: 5,
            burst: 10
        }
    },
    {
        key: 'billingo',
        displayName: 'Billingo',
        connectorType: 'http_api',
        description: 'Billingo API v3: partnerek, termékek, számlatömbök és bizonylatok (számla, díjbekérő, piszkozat) olvasása és kiállítása API-kulccsal.',
        activationHelp: `Csak egy titok kell: a Billingo API-kulcs. Lépések sorban:
1. Lépj be a Billingo-fiókba, és a Beállítások → API oldalon hozz létre egy API-kulcsot (v3). Ha a menüpont nem látszik, a Billingo-csomagod nem tartalmaz API-hozzáférést.
2. A sablon „API-kulcs” mezőjét HAGYD az alapértelmezett alias-néven — ide NE másold a kulcsot.
3. Sandbox-teszt: a kapcsolat elérhetőségi próbája kulcs nélkül fut (nem a te kulcsodat küldi).
4. Aktiváláskor az „API kulcs” mezőbe illeszd a nyers kulcsot, előtag nélkül. A platform ezzel egy valódi olvasó hívást is kipróbál.
5. Kezdd olvasással. Ha az agent számlázhat is, a végpontok közül pipáld be a create_document (és ha kell, create_partner) sort; a kiállított bizonylat emberi jóváhagyás után megy ki.`,
        baseUrl: 'https://api.billingo.hu/v3',
        egressHosts: [
            'api.billingo.hu'
        ],
        authMethods: [
            {
                kind: 'api_key',
                header: 'X-API-KEY'
            }
        ],
        scopeCatalog: [],
        endpoints: [
            {
                name: 'list_partners',
                method: 'GET',
                path: '/partners',
                access: 'read',
                description: 'Partnerek listája. Query: page, per_page (max 100), query (név/adószám keresés). Ezzel kezdj egyeztetéskor.',
                default: true
            },
            {
                name: 'get_partner',
                method: 'GET',
                path: '/partners/{id}',
                access: 'read',
                description: 'Egy partner adatai (számlázási cím, adószám, fizetési mód).',
                default: true
            },
            {
                name: 'create_partner',
                method: 'POST',
                path: '/partners',
                access: 'write',
                description: 'Új partner. Body: {"name":"Minta Kft.","address":{"country_code":"HU","post_code":"1111","city":"Budapest","address":"Fő utca 1."},"emails":["info@example.hu"],"taxcode":"12345678-2-41"}. Előtte list_partners query-vel ellenőrizd, hogy nincs-e már meg.',
                default: false
            },
            {
                name: 'list_products',
                method: 'GET',
                path: '/products',
                access: 'read',
                description: 'Termékek/szolgáltatások listája. Query: page, per_page, query.',
                default: true
            },
            {
                name: 'get_product',
                method: 'GET',
                path: '/products/{id}',
                access: 'read',
                description: 'Egy termék adatai (nettó ár, ÁFA-kulcs, mennyiségi egység).',
                default: true
            },
            {
                name: 'list_documents',
                method: 'GET',
                path: '/documents',
                access: 'read',
                description: 'Bizonylatok listája. Query: page, per_page, query, partner_id, type (invoice|proforma|draft|advance), payment_status (paid|outstanding|expired|partially_paid), start_date, end_date (YYYY-MM-DD).',
                default: true
            },
            {
                name: 'list_document_blocks',
                method: 'GET',
                path: '/document-blocks',
                access: 'read',
                description: 'Számlatömbök listája. A create_document kötelező block_id mezője innen jön.',
                default: true
            },
            {
                name: 'get_document',
                method: 'GET',
                path: '/documents/{id}',
                access: 'read',
                description: 'Egy bizonylat részletei (tételek, összegek, fizetési állapot).',
                default: true
            },
            {
                name: 'create_document',
                method: 'POST',
                path: '/documents',
                access: 'write',
                description: 'Bizonylat létrehozása; a type dönti el: draft (piszkozat, ezzel kezdj), proforma (díjbekérő), invoice (éles számla, NAV-hoz kerül). Kötelező: partner_id, block_id, type, fulfillment_date, due_date, payment_method, language, currency. Példa: {"partner_id":123,"block_id":456,"type":"draft","fulfillment_date":"2026-09-28","due_date":"2026-10-06","payment_method":"wire_transfer","language":"hu","currency":"HUF","items":[{"name":"Tanácsadás","unit_price":50000,"unit_price_type":"net","quantity":1,"unit":"óra","vat":"27%"}]}.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'apiKey',
                label: 'Billingo API-kulcs (Beállítások → API oldalon generált v3 kulcs)',
                type: 'secret',
                required: true,
                secretAliasHint: 'billingo-api-key',
                target: 'auth.secretAliasSuggested'
            }
        ],
        rateLimit: {
            rps: 2,
            burst: 5
        }
    },
    {
        key: 'szamlazz-hu',
        displayName: 'Számlázz.hu',
        connectorType: 'http_api',
        description: 'Számlázz.hu Számla Agent: számlák lekérdezése, adózó-ellenőrzés, és jóváhagyás után számla-kiállítás, sztornó és jóváírás egyetlen Agent-kulccsal.',
        activationHelp: `Csak egy titok kell: a Számla Agent kulcs. Lépések sorban:
1. Lépj be a Számlázz.hu-fiókodba, és a Beállítások → Számla Agent kulcsok oldalon hozz létre egy új kulcsot (pl. „AI agent” néven).
2. Itt a varázslóban nincs kitöltendő mező — a kulcsot csak aktiváláskor kérjük.
3. Sandbox-teszt: kulcs nélkül nem hívjuk a Számlázz.hu-t, ez a lépés automatikusan átmegy.
4. Aktiváláskor az „API kulcs” mezőbe illeszd a Számla Agent kulcsot. A platform ezzel egy valódi, nem módosító lekérdezést futtat — ha a kulcs rossz, itt kiderül.
5. Kezdd olvasással. Ha az agent számlázhat is, pipáld be a create_invoice (és ha kell, reverse_invoice / register_payment) sort; minden kiállítás emberi jóváhagyás után megy ki, és a számla azonnal a NAV-hoz kerül.`,
        baseUrl: 'https://www.szamlazz.hu/szamla',
        egressHosts: [
            'www.szamlazz.hu'
        ],
        protocol: 'szamlazz_agent',
        authMethods: [
            {
                kind: 'bearer'
            }
        ],
        scopeCatalog: [],
        endpoints: [
            {
                name: 'get_invoice',
                method: 'GET',
                path: '/invoice',
                access: 'read',
                description: 'Egy számla adatai XML-ben (fejléc, eladó, vevő, tételek, összegek, fizetési állapot; PDF nélkül). Query: szamlaszam VAGY rendelesSzam VAGY szamlaKulsoAzon. Ismeretlen számlánál 7-es hibakód jön.',
                default: true
            },
            {
                name: 'get_taxpayer',
                method: 'GET',
                path: '/taxpayer',
                access: 'read',
                description: 'Magyar adózó NAV-adatai (név, cím, érvényesség) a Számlázz.hu-n át. Query: torzsszam (az adószám első 8 jegye). Kiállítás előtt ezzel ellenőrizd a vevő adószámát.',
                default: true
            },
            {
                name: 'create_invoice',
                method: 'POST',
                path: '/invoice',
                access: 'write',
                description: 'Számla (vagy "dijbekero": true esetén díjbekérő) kiállítása; éles számla azonnal a NAV-hoz kerül. Az összegeket neked kell kiszámolnod: nettoErtek = nettoEgysegar × mennyiseg, afaErtek = nettoErtek × afakulcs/100, bruttoErtek = nettoErtek + afaErtek. Példa: {"fejlec":{"keltDatum":"2026-09-28","teljesitesDatum":"2026-09-28","fizetesiHataridoDatum":"2026-10-06","fizmod":"Átutalás","penznem":"HUF","szamlaNyelve":"hu","rendelesSzam":"R-123"},"vevo":{"nev":"Minta Kft.","irsz":"1111","telepules":"Budapest","cim":"Fő utca 1.","email":"info@example.hu","sendEmail":false,"adoszam":"12345678-2-41"},"tetelek":[{"megnevezes":"Tanácsadás","mennyiseg":1,"mennyisegiEgyseg":"óra","nettoEgysegar":50000,"afakulcs":"27","nettoErtek":50000,"afaErtek":13500,"bruttoErtek":63500}]}. A válasz a számlaszámot adja vissza.',
                default: false
            },
            {
                name: 'reverse_invoice',
                method: 'POST',
                path: '/invoice/reverse',
                access: 'write',
                description: 'Sztornó számla egy meglévő számlára. Body: {"fejlec":{"szamlaszam":"E-ABC-2026-1","keltDatum":"2026-09-28","teljesitesDatum":"2026-09-28"}}.',
                default: false
            },
            {
                name: 'register_payment',
                method: 'POST',
                path: '/invoice/payment',
                access: 'write',
                description: 'Jóváírás (kifizetés rögzítése) egy számlán. Body: {"szamlaszam":"E-ABC-2026-1","kifizetes":[{"datum":"2026-09-28","jogcim":"átutalás","osszeg":63500}]}. "additiv": false felülírja a korábbi jóváírásokat.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'agentKey',
                label: 'Számla Agent kulcs (Beállítások → Számla Agent kulcsok)',
                type: 'secret',
                required: true,
                secretAliasHint: 'szamlazz-hu-agent-key',
                hiddenInProvisioning: true,
                target: 'auth.secretAliasSuggested'
            }
        ],
        rateLimit: {
            rps: 1,
            burst: 3
        }
    },
    {
        key: 'nav-online-szamla',
        displayName: 'NAV Online Számla',
        connectorType: 'http_api',
        description: 'NAV Online Számla 3.0 lekérdezések: kimenő és bejövő számlák listája és teljes tartalma, számlalánc, adószám-ellenőrzés. Csak olvasás.',
        activationHelp: `Két előfeltétel és egy technikai felhasználó kell. Lépések sorban:
1. Platform-előfeltétel (egyszer, superadmin): Platform · Beállítások → NAV Online Számla oldalon add meg a szoftver azonosítóját (fejlesztő neve, adószáma, elérhetősége). Enélkül a NAV minden hívást elutasít.
2. Lépj be az onlineszamla.nav.gov.hu oldalra a cég elsődleges felhasználójaként, és a Felhasználók menüben hozz létre egy új, „Technikai felhasználó” típusú felhasználót. Jogosultságnak elég a „Számlák lekérdezése”.
3. A technikai felhasználónál kattints a Kulcsgenerálás gombra: az „XML aláírókulcs” kell (a cserekulcs nem).
4. Itt a varázslóban válaszd ki a környezetet (éles vagy teszt), és add meg a cég adószámának első 8 jegyét.
5. Aktiváláskor külön mezőkben kérjük a technikai felhasználó nevét, jelszavát és az aláírókulcsot. A platform ezekkel egy valódi adószám-lekérdezést futtat — ha bármelyik rossz, itt kiderül.`,
        baseUrl: 'https://api.onlineszamla.nav.gov.hu/invoiceService/v3',
        egressHosts: [
            'api.onlineszamla.nav.gov.hu'
        ],
        protocol: 'nav_online_invoice',
        authMethods: [
            {
                kind: 'bearer'
            }
        ],
        credentialFields: [
            {
                name: 'login',
                label: 'Technikai felhasználó neve'
            },
            {
                name: 'password',
                label: 'Technikai felhasználó jelszava',
                secret: true
            },
            {
                name: 'signKey',
                label: 'XML aláírókulcs',
                secret: true
            }
        ],
        scopeCatalog: [],
        endpoints: [
            {
                name: 'get_taxpayer',
                method: 'GET',
                path: '/taxpayer',
                access: 'read',
                description: 'Adózó NAV-adatai (név, cím, érvényesség). Query: taxNumber (az adószám első 8 jegye).',
                default: true
            },
            {
                name: 'list_invoices',
                method: 'GET',
                path: '/invoices',
                access: 'read',
                description: 'Számlák kivonatos listája kiállítási dátum szerint. Query: direction (OUTBOUND = kimenő, INBOUND = bejövő), dateFrom, dateTo (YYYY-MM-DD, legfeljebb 35 nap), page (1-től), opcionálisan partnerTaxNumber, partnerName.',
                default: true
            },
            {
                name: 'get_invoice',
                method: 'GET',
                path: '/invoice',
                access: 'read',
                description: 'Egy számla teljes tartalma (invoiceXml: tételek, összegek). Query: invoiceNumber, direction; bejövő számlánál supplierTaxNumber (a kiállító 8 jegyű adószáma) is kell.',
                default: true
            },
            {
                name: 'check_invoice',
                method: 'GET',
                path: '/invoice/check',
                access: 'read',
                description: 'Igaz/hamis: be van-e jelentve a számla a NAV-hoz. Query: invoiceNumber, direction, (bejövőnél) supplierTaxNumber.',
                default: true
            },
            {
                name: 'get_invoice_chain',
                method: 'GET',
                path: '/invoice/chain',
                access: 'read',
                description: 'Számlalánc (alapszámla + módosító/sztornó számlák). Query: invoiceNumber, direction, (bejövőnél) taxNumber = a kiállító adószáma, page.',
                default: true
            }
        ],
        instanceFields: [
            {
                name: 'environment',
                label: 'NAV környezet: éles (api.onlineszamla…) vagy teszt (api-test.onlineszamla…)',
                type: 'enum',
                required: true,
                enumValues: [
                    'https://api.onlineszamla.nav.gov.hu/invoiceService/v3',
                    'https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3'
                ],
                target: 'baseUrl'
            },
            {
                name: 'taxNumber',
                label: 'A cég adószámának első 8 jegye',
                type: 'string',
                required: true,
                validation: {
                    pattern: '^\\d{8}$'
                },
                example: '12345678',
                target: 'nav.taxNumber'
            },
            {
                name: 'credentials',
                label: 'Technikai felhasználó (név, jelszó, aláírókulcs)',
                type: 'secret',
                required: true,
                secretAliasHint: 'nav-online-szamla-credentials',
                hiddenInProvisioning: true,
                target: 'auth.secretAliasSuggested'
            }
        ],
        rateLimit: {
            rps: 1,
            burst: 3
        }
    },
    {
        key: 'minicrm',
        displayName: 'MiniCRM',
        connectorType: 'http_api',
        description: 'MiniCRM R3 API: modulok, projektek (adatlapok), kontaktok, teendők és e-mailek olvasása; jóváhagyás után létrehozás és módosítás.',
        activationHelp: `Két adat kell: a System ID és az API-kulcs. Lépések sorban:
1. Lépj be a MiniCRM-be adminisztrátorként, és a Beállítások → Rendszer oldalon generálj API-kulcsot.
2. A System ID a MiniCRM címében látszik: r3.minicrm.hu/<System ID>/… — ezt írd be a varázslóban.
3. Sandbox-teszt: a kapcsolat elérhetőségi próbája kulcs nélkül fut.
4. Aktiváláskor az „API kulcs” mezőbe illeszd az API-kulcsot. A platform ezzel egy valódi olvasó hívást futtat.
5. Kezdd olvasással. Ha az agent írhat is, pipáld be a create_/update_ sorokat; minden módosítás emberi jóváhagyás után megy ki. A MiniCRM percenként legfeljebb 60 hívást enged.`,
        baseUrl: 'https://r3.minicrm.hu/Api/R3',
        egressHosts: [
            'r3.minicrm.hu'
        ],
        authMethods: [
            {
                kind: 'basic'
            }
        ],
        scopeCatalog: [],
        endpoints: [
            {
                name: 'list_categories',
                method: 'GET',
                path: '/Category',
                access: 'read',
                description: 'Modulok (kategóriák) listája {CategoryId: név}. Ezzel kezdj: minden projekt egy modulhoz tartozik.',
                default: true
            },
            {
                name: 'get_project_schema',
                method: 'GET',
                path: '/Schema/Project/{categoryId}',
                access: 'read',
                description: 'Egy modul mezői, státuszai és egyedi mezői. Írás előtt ebből derül ki a mezőnév és a StatusId.',
                default: true
            },
            {
                name: 'search_projects',
                method: 'GET',
                path: '/Project',
                access: 'read',
                description: 'Projektek (adatlapok) keresése. Query: CategoryId, StatusId, StatusGroup (Lead|Open|Success|Failed), UserId, UpdatedSince (YYYY-MM-DD HH:MM:SS), Query (szabad szöveg), Page (0-tól, 100/oldal). Válasz: {Count, Results}.',
                default: true
            },
            {
                name: 'get_project',
                method: 'GET',
                path: '/Project/{id}',
                access: 'read',
                description: 'Egy projekt összes mezője.',
                default: true
            },
            {
                name: 'search_contacts',
                method: 'GET',
                path: '/Contact',
                access: 'read',
                description: 'Kontaktok (cégek, személyek) keresése. Query: Query (név, e-mail vagy telefonszám), Page. Válasz: {Count, Results}.',
                default: true
            },
            {
                name: 'get_contact',
                method: 'GET',
                path: '/Contact/{id}',
                access: 'read',
                description: 'Egy kontakt adatai.',
                default: true
            },
            {
                name: 'list_todos',
                method: 'GET',
                path: '/ToDoList/{projectId}',
                access: 'read',
                description: 'Egy projekt teendői. Query: Status (Open|Closed|All).',
                default: true
            },
            {
                name: 'get_todo',
                method: 'GET',
                path: '/ToDo/{id}',
                access: 'read',
                description: 'Egy teendő részletei.',
                default: true
            },
            {
                name: 'list_emails',
                method: 'GET',
                path: '/EmailList/{projectId}',
                access: 'read',
                description: 'Egy projekthez tartozó e-mailek listája.',
                default: true
            },
            {
                name: 'create_project',
                method: 'PUT',
                path: '/Project',
                access: 'write',
                description: 'Új projekt. Kötelező: CategoryId, ContactId. Példa: {"CategoryId":1,"ContactId":123,"Name":"Ajánlatkérés","StatusId":2500}. Előtte search_projects-szel ellenőrizd, hogy nincs-e már meg.',
                default: false
            },
            {
                name: 'update_project',
                method: 'PUT',
                path: '/Project/{id}',
                access: 'write',
                description: 'Projekt módosítása; csak a változó mezőket küldd. Példa: {"StatusId":2501}.',
                default: false
            },
            {
                name: 'create_contact',
                method: 'PUT',
                path: '/Contact',
                access: 'write',
                description: 'Új kontakt. Személy: {"Type":"Person","FirstName":"Anna","LastName":"Kiss","Email":"anna@example.hu","Phone":"+36301234567"}; cég: {"Type":"Business","Name":"Minta Kft."}. Előtte search_contacts.',
                default: false
            },
            {
                name: 'update_contact',
                method: 'PUT',
                path: '/Contact/{id}',
                access: 'write',
                description: 'Kontakt módosítása; csak a változó mezőket küldd.',
                default: false
            },
            {
                name: 'create_todo',
                method: 'PUT',
                path: '/ToDo',
                access: 'write',
                description: 'Új teendő egy projekten. Példa: {"ProjectId":123,"Comment":"Visszahívni","Deadline":"2026-10-01 10:00:00","UserId":45}.',
                default: false
            },
            {
                name: 'update_todo',
                method: 'PUT',
                path: '/ToDo/{id}',
                access: 'write',
                description: 'Nyitott teendő módosítása vagy lezárása. Példa: {"Status":"Closed"}.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'systemId',
                label: 'MiniCRM System ID (a címben: r3.minicrm.hu/<System ID>/)',
                type: 'string',
                required: true,
                validation: {
                    pattern: '^\\d{1,7}$'
                },
                example: '12345',
                target: 'auth.username'
            },
            {
                name: 'apiKey',
                label: 'MiniCRM API-kulcs (Beállítások → Rendszer)',
                type: 'secret',
                required: true,
                secretAliasHint: 'minicrm-api-key',
                hiddenInProvisioning: true,
                target: 'auth.secretAliasSuggested'
            }
        ],
        rateLimit: {
            rps: 1,
            burst: 5
        }
    },
    {
        key: 'pipedrive',
        displayName: 'Pipedrive',
        connectorType: 'http_api',
        description: 'Pipedrive CRM API v2: dealek, személyek, szervezetek, pipeline-ok, aktivitások, leadek és termékek olvasása; jóváhagyás után létrehozás és módosítás. API-tokennel, a cég saját Pipedrive-címén.',
        activationHelp: `Csak két adat kell: a cég Pipedrive-címe és egy API-token. Lépések sorban:
1. Lépj be a Pipedrive-ba, és nézd meg a címsort: https://ceged.pipedrive.com/… — a „ceged.pipedrive.com” részt írd be ide (https nélkül).
2. Ugyanott: Beállítások (fogaskerék) → Személyes beállítások → API. Másold ki a személyes API-tokent. A token a te felhasználód adatait látja — ha az agent a cég egész pipeline-ját kell hogy lássa, egy admin-felhasználó tokenjét add meg.
3. Sandbox-teszt: a kapcsolat elérhetőségi próbája token nélkül fut.
4. Aktiváláskor az „API kulcs” mezőbe illeszd a tokent, előtag nélkül. A platform ezzel egy valódi, nem módosító hívást futtat (felhasználók listája).
5. Kezdd olvasással. Ha az agent írhat is, pipáld be a create_/update_ sorokat; minden módosítás emberi jóváhagyás után megy ki.`,
        baseUrl: 'https://{companyHost}/api/v2',
        egressHosts: [
            '{companyHost}'
        ],
        authMethods: [
            {
                kind: 'api_key',
                header: 'x-api-token'
            }
        ],
        scopeCatalog: [],
        endpoints: [
            {
                name: 'list_users',
                method: 'GET',
                path: '/users',
                access: 'read',
                description: 'Felhasználók (owner_id innen jön). A kapcsolat próbájához ezt hívjuk.',
                default: true
            },
            {
                name: 'list_pipelines',
                method: 'GET',
                path: '/pipelines',
                access: 'read',
                description: 'Pipeline-ok. A stage_id és a deal pipeline_id mezője innen derül ki.',
                default: true
            },
            {
                name: 'list_stages',
                method: 'GET',
                path: '/stages',
                access: 'read',
                description: 'Szakaszok. Query: pipeline_id. Deal létrehozása/mozgatása előtt ezt nézd meg.',
                default: true
            },
            {
                name: 'search_deals',
                method: 'GET',
                path: '/deals/search',
                access: 'read',
                description: 'Dealek keresése. Query: term (kötelező, min. 2 karakter), limit, cursor, exact_match (true|false).',
                default: true
            },
            {
                name: 'list_deals',
                method: 'GET',
                path: '/deals',
                access: 'read',
                description: 'Dealek listája. Query: status (open|won|lost), pipeline_id, stage_id, owner_id, filter_id, updated_since (RFC3339), sort_by, sort_direction (asc|desc), limit (max 500), cursor.',
                default: true
            },
            {
                name: 'get_deal',
                method: 'GET',
                path: '/deals/{id}',
                access: 'read',
                description: 'Egy deal részletei (érték, szakasz, kapcsolódó személy/szervezet).',
                default: true
            },
            {
                name: 'search_persons',
                method: 'GET',
                path: '/persons/search',
                access: 'read',
                description: 'Személyek keresése név/e-mail alapján. Query: term (kötelező), limit, cursor, exact_match.',
                default: true
            },
            {
                name: 'list_persons',
                method: 'GET',
                path: '/persons',
                access: 'read',
                description: 'Személyek listája. Query: owner_id, filter_id, updated_since, limit, cursor.',
                default: true
            },
            {
                name: 'get_person',
                method: 'GET',
                path: '/persons/{id}',
                access: 'read',
                description: 'Egy személy adatai (e-mail, telefon, szervezet).',
                default: true
            },
            {
                name: 'search_organizations',
                method: 'GET',
                path: '/organizations/search',
                access: 'read',
                description: 'Szervezetek keresése. Query: term (kötelező), limit, cursor, exact_match.',
                default: true
            },
            {
                name: 'list_organizations',
                method: 'GET',
                path: '/organizations',
                access: 'read',
                description: 'Szervezetek listája. Query: owner_id, filter_id, updated_since, limit, cursor.',
                default: true
            },
            {
                name: 'get_organization',
                method: 'GET',
                path: '/organizations/{id}',
                access: 'read',
                description: 'Egy szervezet adatai.',
                default: true
            },
            {
                name: 'list_leads',
                method: 'GET',
                path: '/leads',
                access: 'read',
                description: 'Leadek (még nem deal). Query: owner_id, filter_id, updated_since, limit, cursor.',
                default: true
            },
            {
                name: 'list_activities',
                method: 'GET',
                path: '/activities',
                access: 'read',
                description: 'Aktivitások (hívás, meeting, feladat). Query: owner_id, deal_id, person_id, org_id, done (true|false), updated_since, limit, cursor.',
                default: true
            },
            {
                name: 'list_products',
                method: 'GET',
                path: '/products',
                access: 'read',
                description: 'Termékek/szolgáltatások. Query: owner_id, filter_id, ids, limit, cursor.',
                default: true
            },
            {
                name: 'create_deal',
                method: 'POST',
                path: '/deals',
                access: 'write',
                description: 'Új deal. Kötelező: title. Példa: {"title":"Ajánlat — Minta Kft.","value":500000,"currency":"HUF","pipeline_id":1,"stage_id":2,"person_id":10,"org_id":20,"status":"open","expected_close_date":"2026-10-15"}. Előtte search_persons / search_organizations, és list_stages a stage_id-hoz.',
                default: false
            },
            {
                name: 'update_deal',
                method: 'PATCH',
                path: '/deals/{id}',
                access: 'write',
                description: 'Deal módosítása; csak a változó mezőket küldd. Példa: {"stage_id":3} vagy {"status":"won","won_time":"2026-09-26T12:00:00Z"}.',
                default: false
            },
            {
                name: 'create_person',
                method: 'POST',
                path: '/persons',
                access: 'write',
                description: 'Új személy. Kötelező: name. Példa: {"name":"Kiss Anna","emails":[{"value":"anna@example.hu","primary":true,"label":"work"}],"phones":[{"value":"+36301234567","primary":true,"label":"mobile"}],"org_id":20}. Előtte search_persons.',
                default: false
            },
            {
                name: 'update_person',
                method: 'PATCH',
                path: '/persons/{id}',
                access: 'write',
                description: 'Személy módosítása; csak a változó mezőket küldd.',
                default: false
            },
            {
                name: 'create_organization',
                method: 'POST',
                path: '/organizations',
                access: 'write',
                description: 'Új szervezet. Kötelező: name. Példa: {"name":"Minta Kft."}. Előtte search_organizations.',
                default: false
            },
            {
                name: 'update_organization',
                method: 'PATCH',
                path: '/organizations/{id}',
                access: 'write',
                description: 'Szervezet módosítása; csak a változó mezőket küldd.',
                default: false
            },
            {
                name: 'create_activity',
                method: 'POST',
                path: '/activities',
                access: 'write',
                description: 'Új aktivitás. Példa: {"subject":"Visszahívás","type":"call","due_date":"2026-10-01","due_time":"10:00","deal_id":123,"person_id":10,"owner_id":1}.',
                default: false
            },
            {
                name: 'update_activity',
                method: 'PATCH',
                path: '/activities/{id}',
                access: 'write',
                description: 'Aktivitás módosítása vagy lezárása. Példa: {"done":true}.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'companyHost',
                label: 'Pipedrive cégcím (https nélkül, pl. ceged.pipedrive.com)',
                type: 'string',
                required: true,
                validation: {
                    format: 'host',
                    pattern: '^[a-z0-9][a-z0-9-]*\\.pipedrive\\.com$'
                },
                example: 'ceged.pipedrive.com',
                target: 'egressHosts'
            },
            {
                name: 'apiToken',
                label: 'Pipedrive API-token (Beállítások → Személyes → API)',
                type: 'secret',
                required: true,
                secretAliasHint: 'pipedrive-api-token',
                hiddenInProvisioning: true,
                target: 'auth.secretAliasSuggested'
            }
        ],
        rateLimit: {
            rps: 4,
            burst: 8
        }
    },
    {
        key: 'woocommerce',
        displayName: 'WooCommerce',
        connectorType: 'http_api',
        description: 'WooCommerce REST API v3: rendelések, termékek, vevők és értékesítési jelentés. Consumer key + secret (Basic auth) a webshop saját címén.',
        activationHelp: `Három adat kell: a webshop címe, a consumer key és a consumer secret. Lépések sorban:
1. A webshop WordPress-ében: WooCommerce → Beállítások → Speciális → REST API → Kulcs hozzáadása. Név pl. „AI agent”, jogosultság: Olvasás (írás csak ha az agent státuszt is módosíthat).
2. A consumer key (ck_…) ide kerül a varázslóba; a consumer secretet (cs_…) csak aktiváláskor kérjük.
3. A host a webshop címe https nélkül, almappa nélkül — pl. shop.example.hu (ne wp-admin, ne /wp-json). HTTPS kell; HTTP-n a WooCommerce Basic autht nem fogadja.
4. Sandbox-teszt: a kapcsolat elérhetőségi próbája kulcs nélkül fut.
5. Aktiváláskor a consumer secretet illeszd az „API kulcs” mezőbe. A platform egy valódi rendelés-listázást futtat — ha 401 jön, a kulcspár vagy a host rossz.
6. Kezdd olvasással. Ha az agent írhat is (pl. rendelés státusz), pipáld be az update_/create_ sorokat; minden módosítás emberi jóváhagyás után megy ki.`,
        baseUrl: 'https://{storeHost}/wp-json/wc/v3',
        egressHosts: [
            '{storeHost}'
        ],
        authMethods: [
            {
                kind: 'basic'
            }
        ],
        scopeCatalog: [],
        endpoints: [
            {
                name: 'list_orders',
                method: 'GET',
                path: '/orders',
                access: 'read',
                description: 'Rendelések listája. Query: status (pending|processing|on-hold|completed|cancelled|refunded|failed|any), after/before (ISO8601), customer (vevő-azonosító), search, page, per_page (max 100), orderby (date|id|modified), order (asc|desc).',
                default: true
            },
            {
                name: 'get_order',
                method: 'GET',
                path: '/orders/{id}',
                access: 'read',
                description: 'Egy rendelés (tételek, vevő, fizetés, státusz, totál).',
                default: true
            },
            {
                name: 'list_products',
                method: 'GET',
                path: '/products',
                access: 'read',
                description: 'Termékek listája. Query: search, sku, status (publish|draft|pending|private), stock_status (instock|outofstock|onbackorder), category, page, per_page (max 100).',
                default: true
            },
            {
                name: 'get_product',
                method: 'GET',
                path: '/products/{id}',
                access: 'read',
                description: 'Egy termék (ár, készlet, SKU, kategóriák).',
                default: true
            },
            {
                name: 'list_customers',
                method: 'GET',
                path: '/customers',
                access: 'read',
                description: 'Vevők listája. Query: search (név/e-mail), email, role, page, per_page (max 100).',
                default: true
            },
            {
                name: 'get_customer',
                method: 'GET',
                path: '/customers/{id}',
                access: 'read',
                description: 'Egy vevő (számlázási/szállítási cím, rendelésszám).',
                default: true
            },
            {
                name: 'get_sales_report',
                method: 'GET',
                path: '/reports/sales',
                access: 'read',
                description: 'Értékesítési összesítő. Query: date_min, date_max (YYYY-MM-DD), period (week|month|last_month|year).',
                default: true
            },
            {
                name: 'update_order',
                method: 'PUT',
                path: '/orders/{id}',
                access: 'write',
                description: 'Rendelés módosítása. Státusz példa: {"status":"completed"}. Megengedett státusz: pending, processing, on-hold, completed, cancelled, refunded, failed. Más mezőt (tétel, összeg) csak ha az admin ezt kérte.',
                default: false
            },
            {
                name: 'create_order',
                method: 'POST',
                path: '/orders',
                access: 'write',
                description: 'Új rendelés. Példa: {"status":"pending","billing":{"first_name":"Anna","last_name":"Kiss","email":"anna@example.hu"},"line_items":[{"product_id":15,"quantity":1}]}. Előtte list_products sku/search-csel.',
                default: false
            },
            {
                name: 'update_product',
                method: 'PUT',
                path: '/products/{id}',
                access: 'write',
                description: 'Termék módosítása; csak a változó mezőket küldd. Példa: {"stock_quantity":12} vagy {"regular_price":"9900"}.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'storeHost',
                label: 'Webshop host (https nélkül, pl. shop.example.hu)',
                type: 'string',
                required: true,
                validation: {
                    format: 'host'
                },
                example: 'shop.example.hu',
                target: 'egressHosts'
            },
            {
                name: 'consumerKey',
                label: 'Consumer key (ck_…, WooCommerce → Beállítások → Speciális → REST API)',
                type: 'string',
                required: true,
                validation: {
                    pattern: '^ck_[a-zA-Z0-9]+$'
                },
                example: 'ck_0123456789abcdef0123456789abcdef',
                target: 'auth.username'
            },
            {
                name: 'consumerSecret',
                label: 'Consumer secret (cs_…)',
                type: 'secret',
                required: true,
                secretAliasHint: 'woocommerce-consumer-secret',
                hiddenInProvisioning: true,
                target: 'auth.secretAliasSuggested'
            }
        ],
        rateLimit: {
            rps: 2,
            burst: 5
        }
    },
    {
        key: 'shoprenter',
        displayName: 'Shoprenter',
        connectorType: 'http_api',
        description: 'Shoprenter REST API: rendelések, termékek, vevők, kategóriák, készlet és rendelési státuszok. HTTP Basic auth a bolt *.shoprenter.hu API-címén.',
        activationHelp: `Három adat kell: a bolt Shoprenter-hostja, az API-felhasználónév és az API-jelszó. Lépések sorban:
1. A Shoprenter adminban: Beállítások → Rendszer → API. Kapcsold be az API-t, állíts felhasználónevet és jelszót, majd ments.
2. A host mindig a *.shoprenter.hu cím — még akkor is, ha a webshop saját domainen fut. A címsorban: https://boltod.shoprenter.hu/admin → ide „boltod.shoprenter.hu” kerül (https nélkül).
3. Az API-felhasználónevet írd be a varázslóba. Az API-jelszót csak aktiváláskor kérjük.
4. Sandbox-teszt: a kapcsolat elérhetőségi próbája jelszó nélkül fut.
5. Aktiváláskor az API-jelszót illeszd az „API kulcs” mezőbe. A platform a rendelési státuszok listáját kéri le — ha 401 jön, a host vagy a jelszó rossz.
6. Kezdd olvasással. Ha az agent írhat is (pl. rendelés státusz), pipáld be az update_ sorokat; minden módosítás emberi jóváhagyás után megy ki. A Shoprenter JSON:API formátumot vár: {"data":{"type":"orders","id":"123",…}}.`,
        baseUrl: 'https://{shopHost}/api',
        egressHosts: [
            '{shopHost}'
        ],
        authMethods: [
            {
                kind: 'basic'
            }
        ],
        scopeCatalog: [],
        endpoints: [
            {
                name: 'list_order_statuses',
                method: 'GET',
                path: '/orderStatuses',
                access: 'read',
                description: 'Rendelési státuszok {id, name}. Ezzel kezdj: az update_order status-id-ja innen jön. A kapcsolat próbájához is ezt hívjuk.',
                default: true
            },
            {
                name: 'list_orders',
                method: 'GET',
                path: '/orders',
                access: 'read',
                description: 'Rendelések listája. Query: page, limit (max 25), extend (pl. orderStatus,customer,orderProducts). Szűrés: filter[orderNumber]=R-1001.',
                default: true
            },
            {
                name: 'get_order',
                method: 'GET',
                path: '/orders/{id}',
                access: 'read',
                description: 'Egy rendelés. Query: extend=orderStatus,customer,orderProducts,shippingMode,paymentMode.',
                default: true
            },
            {
                name: 'list_products',
                method: 'GET',
                path: '/products',
                access: 'read',
                description: 'Termékek listája. Query: page, limit, extend (productDescriptions,productImages,stock). Szűrés: filter[sku]=ABC-1.',
                default: true
            },
            {
                name: 'get_product',
                method: 'GET',
                path: '/products/{id}',
                access: 'read',
                description: 'Egy termék. Query: extend=productDescriptions,productImages,stock,productClass.',
                default: true
            },
            {
                name: 'list_customers',
                method: 'GET',
                path: '/customers',
                access: 'read',
                description: 'Vevők listája. Query: page, limit. Szűrés: filter[email]=anna@example.hu.',
                default: true
            },
            {
                name: 'get_customer',
                method: 'GET',
                path: '/customers/{id}',
                access: 'read',
                description: 'Egy vevő. Query: extend=customerAddresses.',
                default: true
            },
            {
                name: 'list_categories',
                method: 'GET',
                path: '/productClasses',
                access: 'read',
                description: 'Termékkategóriák. Query: page, limit, extend=productClassDescriptions.',
                default: true
            },
            {
                name: 'list_stocks',
                method: 'GET',
                path: '/stocks',
                access: 'read',
                description: 'Készletek. Query: page, limit. A termék stock kapcsolatán át is elérhető.',
                default: true
            },
            {
                name: 'update_order',
                method: 'PATCH',
                path: '/orders/{id}',
                access: 'write',
                description: 'Rendelés módosítása (jellemzően státusz). JSON:API body. Példa: {"data":{"type":"orders","id":"123","relationships":{"orderStatus":{"data":{"type":"orderStatuses","id":"5"}}}}}. Az id-t a list_order_statuses adja.',
                default: false
            },
            {
                name: 'update_product',
                method: 'PATCH',
                path: '/products/{id}',
                access: 'write',
                description: 'Termék módosítása. JSON:API body. Példa: {"data":{"type":"products","id":"45","attributes":{"price":9900}}}.',
                default: false
            }
        ],
        instanceFields: [
            {
                name: 'shopHost',
                label: 'Shoprenter host (https nélkül, pl. boltod.shoprenter.hu)',
                type: 'string',
                required: true,
                validation: {
                    format: 'host',
                    pattern: '^[a-z0-9][a-z0-9-]*\\.shoprenter\\.hu$'
                },
                example: 'boltod.shoprenter.hu',
                target: 'egressHosts'
            },
            {
                name: 'username',
                label: 'API felhasználónév (Beállítások → Rendszer → API)',
                type: 'string',
                required: true,
                example: 'api',
                target: 'auth.username'
            },
            {
                name: 'apiPassword',
                label: 'API jelszó',
                type: 'secret',
                required: true,
                secretAliasHint: 'shoprenter-api-password',
                hiddenInProvisioning: true,
                target: 'auth.secretAliasSuggested'
            }
        ],
        rateLimit: {
            rps: 1,
            burst: 3
        }
    }
];
}),
"[project]/src/domain/connector-template/ostorosbor-config-enrichment.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "OSTOROSBOR_READ_POST_REPORT_TOOLS",
    ()=>OSTOROSBOR_READ_POST_REPORT_TOOLS,
    "OSTOROSBOR_TEMPLATE_KEYS",
    ()=>OSTOROSBOR_TEMPLATE_KEYS,
    "effectiveConnectorRuntimeConfig",
    ()=>effectiveConnectorRuntimeConfig,
    "enrichOstorosborConnectorConfig",
    ()=>enrichOstorosborConnectorConfig,
    "enrichOstorosborPrivacy",
    ()=>enrichOstorosborPrivacy,
    "enrichOstorosborReadPostReports",
    ()=>enrichOstorosborReadPostReports,
    "enrichOstorosborTraceHeaders",
    ()=>enrichOstorosborTraceHeaders,
    "ostorosborTemplateKey",
    ()=>ostorosborTemplateKey
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$provisioning$2f$connector$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/provisioning/connector-config.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/privacy/connector-privacy.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$template$2f$custom$2d$template$2d$seeds$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-template/custom-template-seeds.ts [app-rsc] (ecmascript)");
;
;
;
const OSTOROSBOR_TEMPLATE_KEYS = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["OSTOROSBOR_CRM_TEMPLATE_KEYS"];
/** Ostoros connector API path — report query/export POST-ok itt olvasók. */ const OSTOROSBOR_CONNECTOR_API_SUFFIX = /\/api\/connector\/v1\/?$/i;
const OSTOROSBOR_TRUSTED_CRM_HOSTS = new Set([
    'ostorosbor-crm--e-ai-ab8f1.europe-west4.hosted.app',
    'ostorosbor-crm--enterprise-ai-demo.europe-west4.hosted.app'
]);
const OSTOROSBOR_READ_POST_REPORT_TOOLS = [
    {
        name: 'query_report',
        method: 'POST',
        path: '/reports/query',
        access: 'write',
        risk: 'read',
        description: 'Riportlekérdezés (nem módosít). Kötelező: period.from + period.to (YYYY-MM-DD, inkluzív); plusz preset VAGY dataset+measures. Példa: {"preset":"turnover","period":{"from":"2026-01-01","to":"2026-06-30"}}'
    },
    {
        name: 'export_report',
        method: 'POST',
        path: '/reports/exports',
        access: 'write',
        risk: 'read',
        description: 'Riportexport (nem módosít). Ugyanaz a body, mint /reports/query, plusz format: "csv"|"xlsx".'
    }
];
function ostorosborTemplateKey(config) {
    const key = config.provenance?.templateKey ?? config.provider;
    return key && OSTOROSBOR_TEMPLATE_KEYS.has(key) ? key : null;
}
function isOstorosborConnectorApi(config) {
    if (ostorosborTemplateKey(config)) return true;
    return OSTOROSBOR_CONNECTOR_API_SUFFIX.test(config.baseUrl);
}
/**
 * Trace-fejlécet csak a platform által ismert Ostoros CRM hostnak adunk automatikusan.
 * A self-updating kapcsolat neve és OpenAPI-ja admin által megadható, ezért ezek nem
 * elegendőek ahhoz, hogy az acting-user e-mail külső API-hoz kerülhessen.
 */ function isTrustedOstorosborCrm(config) {
    if (ostorosborTemplateKey(config)) return true;
    return OSTOROSBOR_TRUSTED_CRM_HOSTS.has(new URL(config.baseUrl).hostname);
}
function toolKey(tool) {
    return `${tool.method.toUpperCase()} ${tool.path}`;
}
function enrichOstorosborReadPostReports(config) {
    if (!isOstorosborConnectorApi(config)) {
        return {
            config,
            changed: false
        };
    }
    const templateKey = ostorosborTemplateKey(config);
    const canAddMissing = templateKey === 'ostorosbor-crm-service-insight';
    let changed = false;
    const nextTools = [
        ...config.proposedTools
    ];
    for (const canonical of OSTOROSBOR_READ_POST_REPORT_TOOLS){
        const key = toolKey(canonical);
        const existingIdx = nextTools.findIndex((t)=>toolKey(t) === key);
        if (existingIdx >= 0) {
            const existing = nextTools[existingIdx];
            if (existing.risk !== 'read') {
                nextTools[existingIdx] = {
                    ...existing,
                    risk: 'read',
                    ...existing.description ? {} : {
                        description: canonical.description
                    }
                };
                changed = true;
            }
            continue;
        }
        if (!canAddMissing) continue;
        nextTools.push({
            ...canonical
        });
        changed = true;
    }
    if (!changed) return {
        config,
        changed: false
    };
    return {
        config: {
            ...config,
            proposedTools: nextTools
        },
        changed: true
    };
}
function enrichOstorosborTraceHeaders(config) {
    if (!isTrustedOstorosborCrm(config) || config.requestHeaders && Object.keys(config.requestHeaders).length > 0) {
        return {
            config,
            changed: false
        };
    }
    return {
        config: {
            ...config,
            requestHeaders: {
                ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$template$2f$custom$2d$template$2d$seeds$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["OSTOROSBOR_CRM_REQUEST_HEADERS"]
            }
        },
        changed: true
    };
}
function enrichOstorosborPrivacy(config) {
    if (!isTrustedOstorosborCrm(config)) {
        return {
            config,
            changed: false
        };
    }
    let changed = false;
    let next = config;
    if (!next.privacy) {
        next = {
            ...next,
            privacy: {
                ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["OSTOROSBOR_CRM_PRIVACY_CAPABILITIES"]
            }
        };
        changed = true;
    }
    if (!next.fields) {
        next = {
            ...next,
            fields: {
                ...__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["OSTOROSBOR_CRM_PRIVACY_FIELDS"]
            }
        };
        changed = true;
    }
    return {
        config: next,
        changed
    };
}
function effectiveConnectorRuntimeConfig(raw) {
    try {
        return enrichOstorosborConnectorConfig((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$provisioning$2f$connector$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["normalizeConnectorConfig"])(raw)).config;
    } catch  {
        return raw;
    }
}
function enrichOstorosborConnectorConfig(config) {
    let changed = false;
    let next = config;
    const traceHeaders = enrichOstorosborTraceHeaders(next);
    if (traceHeaders.changed) {
        next = traceHeaders.config;
        changed = true;
    }
    const reports = enrichOstorosborReadPostReports(next);
    if (reports.changed) {
        next = reports.config;
        changed = true;
    }
    const privacy = enrichOstorosborPrivacy(next);
    if (privacy.changed) {
        next = privacy.config;
        changed = true;
    }
    return {
        config: next,
        changed
    };
}
}),
"[project]/src/domain/connector-self-update/pinned-runtime-config.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "isConnectorAssignableToAgent",
    ()=>isConnectorAssignableToAgent,
    "pinnedRuntimeConfig",
    ()=>pinnedRuntimeConfig
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$capability$2d$set$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-self-update/capability-set.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$template$2f$ostorosbor$2d$config$2d$enrichment$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-template/ostorosbor-config-enrichment.ts [app-rsc] (ecmascript)");
;
;
function pinnedRuntimeConfig(connectorMode, fixedConfig, activeCapabilitySet) {
    if (connectorMode === 'fixed') return fixedConfig;
    const set = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$capability$2d$set$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["parseCapabilitySet"])(activeCapabilitySet);
    if (!set) return null;
    const runtimeConfig = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$template$2f$ostorosbor$2d$config$2d$enrichment$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["enrichOstorosborConnectorConfig"])(set).config;
    return {
        ...runtimeConfig,
        ...privacyDeclarationFromConfig(fixedConfig),
        restrictToEndpoints: true,
        selfUpdatingPinned: true
    };
}
/**
 * A forrás privacy-katalógusa (issue #320) a `connectors.config`-ba szinkronizálódik,
 * a rögzített capability-snapshot viszont a jóváhagyott spec-verzióból jön. A
 * mezőjelölés NEM képesség: nem tágít hívási felületet, csak azt mondja meg, mit
 * kell álnévre cserélni. Ezért a frissebb jelölés a pinned configra is ráíródik —
 * enélkül egy önfrissítő kapcsolat a hónapokkal korábbi snapshot jelölésével
 * tokenizálna, a friss katalógus mezői pedig nyersen mennének a modellhez.
 * Az endpoint-allowlist és minden más továbbra is a snapshotból származik.
 */ function privacyDeclarationFromConfig(fixedConfig) {
    if (!fixedConfig || typeof fixedConfig !== 'object' || Array.isArray(fixedConfig)) return {};
    const config = fixedConfig;
    const slice = {};
    for (const key of [
        'fields',
        'privacy',
        'entity_types',
        'unlisted_default',
        'catalog_version'
    ]){
        if (config[key] !== undefined) slice[key] = config[key];
    }
    return slice;
}
function isConnectorAssignableToAgent(connectorMode, activeCapabilitySet) {
    if (connectorMode === 'fixed') return true;
    return pinnedRuntimeConfig('self_updating', {}, activeCapabilitySet) !== null;
}
}),
"[project]/src/domain/connector/runtime-config.ts [app-rsc] (ecmascript) <locals>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$pinned$2d$runtime$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-self-update/pinned-runtime-config.ts [app-rsc] (ecmascript)");
;
}),
"[project]/src/repositories/postgres/connector-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresConnectorRepository",
    ()=>PostgresConnectorRepository,
    "resolveRuntimeConnector",
    ()=>resolveRuntimeConnector
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$runtime$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/src/domain/connector/runtime-config.ts [app-rsc] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$pinned$2d$runtime$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-self-update/pinned-runtime-config.ts [app-rsc] (ecmascript)");
;
;
function resolveRuntimeConnector(row) {
    const { activeSpecVersion, ...connector } = row;
    if (connector.connectorMode !== 'self_updating') return connector;
    const pinned = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$pinned$2d$runtime$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["pinnedRuntimeConfig"])('self_updating', connector.config, activeSpecVersion?.capabilitySet ?? null);
    if (pinned === null) return null;
    return {
        ...connector,
        config: pinned
    };
}
class PostgresConnectorRepository {
    async findById(id, tenantId) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.findFirst({
            where: tenantId ? {
                id,
                tenantId
            } : {
                id
            },
            include: {
                activeSpecVersion: {
                    select: {
                        capabilitySet: true
                    }
                }
            }
        });
        return row ? resolveRuntimeConnector(row) : null;
    }
    async findByTenantTypeAndName(tenantId, type, name) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.findUnique({
            where: {
                tenantId_type_name: {
                    tenantId,
                    type,
                    name
                }
            }
        });
    }
    async findByNameInTenant(tenantId, name) {
        const trimmed = name.trim();
        if (!trimmed) return this.listForTenant(tenantId);
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.findMany({
            where: {
                tenantId,
                name: {
                    equals: trimmed,
                    mode: 'insensitive'
                }
            },
            orderBy: {
                name: 'asc'
            }
        });
    }
    async listForTenant(tenantId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.findMany({
            where: {
                tenantId
            },
            orderBy: {
                name: 'asc'
            }
        });
    }
    async listActive(tenantId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.findMany({
            where: {
                tenantId,
                lifecycleState: 'active',
                type: {
                    in: [
                        'google_drive',
                        'http_api',
                        'gmail'
                    ]
                }
            },
            orderBy: {
                name: 'asc'
            }
        });
    }
    async create(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.create({
            data: {
                tenantId: input.tenantId,
                type: input.type,
                name: input.name,
                authMode: input.authMode,
                scope: input.scope,
                lifecycleState: 'active'
            }
        });
    }
}
}),
"[project]/src/domain/connector/catalog-description.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Secret-mentes connector-katalógus leírás (agent választó, admin UI).
 * Önfrissítőnél a capability snapshot; fix http_api-nál a config.
 */ __turbopack_context__.s([
    "describeConnectorCatalog",
    ()=>describeConnectorCatalog
]);
function trimText(value, max) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text ? text.slice(0, max) : null;
}
function describeConnectorCatalog(type, config, capabilitySet) {
    if (type === 'gmail') {
        return {
            description: 'Gmail-fiók olvasása és írása a felhasználó nevében, engedélyhez kötve.',
            baseUrl: null,
            tools: []
        };
    }
    if (type === 'code_sandbox') {
        const cfg = config;
        const baseUrl = typeof cfg?.baseUrl === 'string' ? cfg.baseUrl : null;
        return {
            description: 'Izolált külső doboz, ahol az agent által írt kód fut. A platform-adatok csak a futtatás bemenetén kerülnek be.',
            baseUrl,
            tools: []
        };
    }
    const cfg = capabilitySet ?? config;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        return {
            description: null,
            baseUrl: null,
            tools: []
        };
    }
    const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : null;
    const provider = typeof cfg.provider === 'string' ? cfg.provider : null;
    const apiDescription = trimText(cfg.description, 500);
    const rawTools = Array.isArray(cfg.proposedTools) ? cfg.proposedTools : Array.isArray(cfg.endpoints) ? cfg.endpoints : [];
    const tools = rawTools.filter((t)=>typeof t === 'object' && t !== null).map((t)=>({
            method: String(t.method ?? ''),
            path: String(t.path ?? ''),
            ...typeof t.description === 'string' && t.description.trim() ? {
                description: t.description.trim().slice(0, 300)
            } : {}
        })).filter((t)=>t.method && t.path).slice(0, 50);
    if (apiDescription) {
        return {
            description: apiDescription,
            baseUrl,
            tools
        };
    }
    if (tools.length === 0) {
        if (!provider && !baseUrl) return {
            description: null,
            baseUrl,
            tools: []
        };
        return {
            description: [
                provider,
                baseUrl
            ].filter(Boolean).join(' · ') || null,
            baseUrl,
            tools: []
        };
    }
    const withDesc = tools.filter((t)=>t.description).length;
    const head = withDesc > 0 ? tools.filter((t)=>t.description).slice(0, 2).map((t)=>t.description).join(' ').slice(0, 300) : `${tools.length} művelet${provider ? ` · ${provider}` : ''}${baseUrl ? ` · ${baseUrl}` : ''}`;
    return {
        description: head || null,
        baseUrl,
        tools
    };
}
}),
"[project]/src/lib/privacy-slot.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "withConnectorPrivacySlot",
    ()=>withConnectorPrivacySlot
]);
async function withConnectorPrivacySlot(_db, data) {
    return data;
}
}),
"[project]/src/repositories/postgres/connector-draft-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresConnectorDraftRepository",
    ()=>PostgresConnectorDraftRepository
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__ = __turbopack_context__.i("[externals]/@prisma/client [external] (@prisma/client, cjs, [project]/node_modules/@prisma/client)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$catalog$2d$description$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector/catalog-description.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$runtime$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/src/domain/connector/runtime-config.ts [app-rsc] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$pinned$2d$runtime$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-self-update/pinned-runtime-config.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$privacy$2d$slot$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/privacy-slot.ts [app-rsc] (ecmascript)");
;
;
;
;
;
/** Agent-kötés dropdown és assign: ugyanaz a fail-closed szabály, mint a runtime listán. */ function isProvisioningCatalogConnectorAssignable(connectorMode, activeCapabilitySet, specSource) {
    if (connectorMode === 'self_updating') {
        if (!specSource?.urlApprovedAt || !specSource?.trustedAt) return false;
    }
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$pinned$2d$runtime$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isConnectorAssignableToAgent"])(connectorMode, activeCapabilitySet);
}
class PostgresConnectorDraftRepository {
    async createDraft(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const connector = await tx.connector.create({
                data: await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$privacy$2d$slot$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["withConnectorPrivacySlot"])(tx, {
                    type: input.connectorType ?? 'http_api',
                    name: input.name,
                    authMode: input.authMode,
                    scope: 'single',
                    secretAlias: input.secretAliasSuggested,
                    config: input.config,
                    lifecycleState: 'draft',
                    tenantId: input.tenantId
                })
            });
            const draft = await tx.connectorDraft.create({
                data: {
                    tenantId: input.tenantId,
                    connectorId: connector.id,
                    sourceType: input.sourceType,
                    sourceRef: input.sourceRef,
                    sourceHash: input.sourceHash,
                    generatedByAgentId: input.generatedByAgentId,
                    reviewStatus: 'pending'
                },
                include: {
                    connector: true
                }
            });
            return draft;
        });
    }
    async findById(draftId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorDraft.findUnique({
            where: {
                id: draftId
            },
            include: {
                connector: true
            }
        });
    }
    async findByConnectorId(connectorId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorDraft.findUnique({
            where: {
                connectorId
            },
            include: {
                connector: true
            }
        });
    }
    async list(tenantId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorDraft.findMany({
            where: {
                tenantId
            },
            include: {
                connector: true
            },
            orderBy: {
                createdAt: 'desc'
            }
        });
    }
    async setValidationResult(draftId, result) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorDraft.update({
            where: {
                id: draftId
            },
            data: {
                validationResult: result
            }
        });
    }
    async setReview(params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorDraft.update({
            where: {
                id: params.draftId
            },
            data: {
                reviewStatus: params.reviewStatus,
                reviewedById: params.reviewedById
            }
        });
    }
    async setSandboxTestResult(draftId, ok) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorDraft.update({
            where: {
                id: draftId
            },
            data: {
                sandboxTestOk: ok
            }
        });
    }
    async activate(params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const draft = await tx.connectorDraft.update({
                where: {
                    id: params.draftId
                },
                data: {
                    secondApproverId: params.secondApproverId
                }
            });
            return tx.connector.update({
                where: {
                    id: draft.connectorId
                },
                data: {
                    lifecycleState: 'active',
                    secretAlias: params.secretAlias,
                    authMode: params.authMode,
                    ...params.config !== undefined ? {
                        config: params.config
                    } : {}
                }
            });
        });
    }
    async assignToAgent(params) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentConnector.upsert({
            where: {
                agentId_connectorId: {
                    agentId: params.agentId,
                    connectorId: params.connectorId
                }
            },
            create: {
                agentId: params.agentId,
                connectorId: params.connectorId,
                accessMode: params.accessMode
            },
            update: {
                accessMode: params.accessMode
            }
        });
    }
    async unassignFromAgent(params) {
        const result = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentConnector.deleteMany({
            where: {
                agentId: params.agentId,
                connectorId: params.connectorId
            }
        });
        return {
            removed: result.count > 0
        };
    }
    async updateDraftConfig(params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const draft = await tx.connectorDraft.findUnique({
                where: {
                    id: params.draftId
                },
                include: {
                    connector: true
                }
            });
            if (!draft) throw new Error('draft not found');
            // Kemény padló: csak még NEM aktivált connector configja írható itt felül.
            if (draft.connector.lifecycleState !== 'draft' && draft.connector.lifecycleState !== 'validated') {
                throw new Error('only draft/validated connector config is editable');
            }
            await tx.connector.update({
                where: {
                    id: draft.connectorId
                },
                data: {
                    config: params.config,
                    authMode: params.authMode,
                    secretAlias: params.secretAliasSuggested,
                    lifecycleState: 'draft'
                }
            });
            // A config megváltozott → a gate resetelődik, hogy újra végigfusson.
            return tx.connectorDraft.update({
                where: {
                    id: params.draftId
                },
                data: {
                    sourceHash: params.sourceHash,
                    validationResult: __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].DbNull,
                    reviewStatus: 'pending',
                    reviewedById: null,
                    secondApproverId: null,
                    sandboxTestOk: null
                },
                include: {
                    connector: true
                }
            });
        });
    }
    async reopen(params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const draft = await tx.connectorDraft.findUnique({
                where: {
                    id: params.draftId
                },
                include: {
                    connector: true
                }
            });
            if (!draft) throw new Error('draft not found');
            if (draft.connector.lifecycleState !== 'active') {
                throw new Error('only an active connector can be reopened');
            }
            // A gate resetelése — a javított config újra végigmegy a valid→sandbox→review úton.
            await tx.connectorDraft.update({
                where: {
                    id: params.draftId
                },
                data: {
                    validationResult: __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].DbNull,
                    reviewStatus: 'pending',
                    reviewedById: null,
                    secondApproverId: null,
                    sandboxTestOk: null
                }
            });
            // Offline: a Tool Broker `lifecycle_state != active` esetén tilt. Az agent-kötéseket
            // és capability-ket szándékosan MEGTARTJUK — újraaktiváláskor a wiring visszaáll.
            return tx.connector.update({
                where: {
                    id: draft.connectorId
                },
                data: {
                    lifecycleState: 'draft'
                }
            });
        });
    }
    async findConnectorById(connectorId) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.findUnique({
            where: {
                id: connectorId
            },
            select: {
                id: true,
                tenantId: true,
                lifecycleState: true,
                secretAlias: true
            }
        });
        if (!row) return null;
        return {
            id: row.id,
            tenantId: row.tenantId,
            lifecycleState: row.lifecycleState,
            secretAlias: row.secretAlias
        };
    }
    async isAssignableToAgent(connectorId) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.findUnique({
            where: {
                id: connectorId
            },
            select: {
                connectorMode: true,
                activeSpecVersion: {
                    select: {
                        capabilitySet: true
                    }
                },
                specSource: {
                    select: {
                        urlApprovedAt: true,
                        trustedAt: true
                    }
                }
            }
        });
        if (!row) return false;
        return isProvisioningCatalogConnectorAssignable(row.connectorMode, row.activeSpecVersion?.capabilitySet ?? null, row.specSource);
    }
    async decommission(params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const draft = await tx.connectorDraft.findUnique({
                where: {
                    id: params.draftId
                },
                include: {
                    connector: true
                }
            });
            if (!draft) throw new Error('draft not found');
            return this.decommissionActiveConnectorTx(tx, draft.connectorId);
        });
    }
    async decommissionByConnectorId(params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>this.decommissionActiveConnectorTx(tx, params.connectorId));
    }
    async decommissionActiveConnectorTx(tx, connectorId) {
        const connector = await tx.connector.findUnique({
            where: {
                id: connectorId
            }
        });
        if (!connector) throw new Error('connector not found');
        if (connector.lifecycleState !== 'active') {
            throw new Error('only an active connector can be decommissioned');
        }
        const links = await tx.agentConnector.findMany({
            where: {
                connectorId
            },
            select: {
                agentId: true
            }
        });
        const affectedAgentIds = [
            ...new Set(links.map((l)=>l.agentId))
        ];
        await tx.agentConnector.deleteMany({
            where: {
                connectorId
            }
        });
        await tx.connector.update({
            where: {
                id: connectorId
            },
            data: {
                lifecycleState: 'archived'
            }
        });
        return {
            connectorId,
            affectedAgentIds
        };
    }
    async deleteDraft(params) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const draft = await tx.connectorDraft.findUnique({
                where: {
                    id: params.draftId
                },
                include: {
                    connector: true
                }
            });
            if (!draft) throw new Error('draft not found');
            const state = draft.connector.lifecycleState;
            const deletable = state === 'draft' || state === 'validated' || params.allowArchived === true && state === 'archived';
            if (!deletable) {
                throw new Error('only a never-activated draft can be hard-deleted');
            }
            // A connector-sor törlése kaszkádban viszi a draftot, agent_connectors/grantek sorait.
            await tx.connector.delete({
                where: {
                    id: draft.connectorId
                }
            });
        });
    }
    async hardDeleteArchivedConnector(params) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const connector = await tx.connector.findUnique({
                where: {
                    id: params.connectorId
                }
            });
            if (!connector) throw new Error('connector not found');
            if (connector.lifecycleState !== 'archived') {
                throw new Error('only an archived connector can be hard-deleted');
            }
            await tx.connector.delete({
                where: {
                    id: params.connectorId
                }
            });
        });
    }
    async listActiveCatalog(tenantId) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.findMany({
            where: {
                tenantId,
                lifecycleState: 'active',
                type: {
                    in: [
                        'google_drive',
                        'http_api',
                        'gmail'
                    ]
                }
            },
            select: {
                id: true,
                type: true,
                name: true,
                config: true,
                connectorMode: true,
                activeSpecVersion: {
                    select: {
                        capabilitySet: true
                    }
                },
                specSource: {
                    select: {
                        urlApprovedAt: true,
                        trustedAt: true
                    }
                }
            },
            orderBy: {
                name: 'asc'
            }
        });
        return rows.filter((row)=>isProvisioningCatalogConnectorAssignable(row.connectorMode, row.activeSpecVersion?.capabilitySet ?? null, row.specSource)).map((row)=>({
                id: row.id,
                type: row.type,
                name: row.name,
                connectorMode: row.connectorMode,
                ...(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2f$catalog$2d$description$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["describeConnectorCatalog"])(row.type, row.config, row.activeSpecVersion?.capabilitySet ?? null)
            }));
    }
}
}),
"[project]/src/repositories/postgres/connector-template-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresConnectorTemplateRepository",
    ()=>PostgresConnectorTemplateRepository
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
;
class PostgresConnectorTemplateRepository {
    async listVisible(scope) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorTemplate.findMany({
            where: {
                status: {
                    in: [
                        'active',
                        'deprecated'
                    ]
                },
                OR: [
                    {
                        tenantId: null
                    },
                    ...scope.tenantId ? [
                        {
                            tenantId: scope.tenantId
                        }
                    ] : []
                ]
            },
            orderBy: [
                {
                    displayName: 'asc'
                },
                {
                    version: 'desc'
                }
            ]
        });
    }
    async findLatestByKey(key, tenantId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorTemplate.findFirst({
            where: {
                key,
                status: {
                    in: [
                        'active',
                        'deprecated'
                    ]
                },
                OR: [
                    {
                        tenantId: null
                    },
                    ...tenantId ? [
                        {
                            tenantId
                        }
                    ] : []
                ]
            },
            orderBy: [
                {
                    version: 'desc'
                }
            ]
        });
    }
    async findByIdVersion(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorTemplate.findUnique({
            where: {
                id
            }
        });
    }
    async createVersion(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorTemplate.create({
            data: {
                key: input.key,
                version: input.version,
                origin: input.origin,
                displayName: input.displayName,
                description: input.description ?? null,
                tenantId: input.tenantId,
                descriptor: input.descriptor,
                status: input.status ?? 'active',
                createdById: input.createdById ?? null
            }
        });
    }
    async deprecate(id) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorTemplate.update({
            where: {
                id
            },
            data: {
                status: 'deprecated'
            }
        });
    }
    async upsertBuiltin(input) {
        const existing = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorTemplate.findFirst({
            where: {
                key: input.key,
                version: input.version,
                tenantId: null,
                origin: 'builtin'
            }
        });
        if (!existing) return this.createVersion({
            ...input,
            origin: 'builtin',
            tenantId: null
        });
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorTemplate.update({
            where: {
                id: existing.id
            },
            data: {
                displayName: input.displayName,
                description: input.description ?? null,
                descriptor: input.descriptor,
                status: input.status ?? 'active'
            }
        });
    }
}
}),
"[project]/src/domain/connector-self-update/spec-diff.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Önfrissítő connector — capability-diff-motor (Dev-Spec §6, A2).
 *
 * A diff a spec SZÍVE: nem szövegdiffet, hanem CAPABILITY-szintű, kategorizált
 * változást ad, a használati kontextussal együtt ("mi változott ÉS ki használja").
 * Ez teszi az "egy gombot" biztonságossá — a jóváhagyó sosem vakon dönt.
 *
 * TISZTA modul: nincs DB, nincs hálózat. A "ki használja" visszakeresést a hívó
 * `usedByResolver`-ként injektálja (WP-4/WP-3 a repository-ból); a determinisztikus
 * teszt stubbal hívja.
 *
 * Kategóriák (§6):
 *  - added    : új végpont / új opcionális képesség — Alacsony kockázat (D5 auto-jelölt)
 *  - breaking : MOST HASZNÁLT végpont eltűnt, vagy paraméter kötelezővé/típusban változott — Magas
 *  - narrowed : a partner elvett egy végpontot, amit NEM használunk aktívan — Közepes
 *  - auth     : auth-mód változott, vagy egy fejléc kötelezővé vált (pl. Idempotency-Key) — Magas
 */ __turbopack_context__.s([
    "computeCapabilityDiff",
    ()=>computeCapabilityDiff,
    "isAutoApprovable",
    ()=>isAutoApprovable
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$capability$2d$set$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-self-update/capability-set.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/privacy/connector-privacy.ts [app-rsc] (ecmascript)");
;
;
function accessOf(tool) {
    return tool.access;
}
function parameterIndex(tool) {
    return new Map((tool.parameters ?? []).map((param)=>[
            `${param.in}:${param.name.toLowerCase()}`,
            param
        ]));
}
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value).filter(([key])=>key !== 'secretAliasSuggested').sort(([a], [b])=>a.localeCompare(b)).map(([key, item])=>`${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
/** A használók listája — üres tömb helyett `undefined`, hogy a JSON tömör maradjon. */ function usedBy(resolver, op) {
    if (!resolver) return undefined;
    const refs = resolver(op);
    return refs.length > 0 ? refs : undefined;
}
function computeCapabilityDiff(current, next, usedByResolver) {
    const added = [];
    const breaking = [];
    const narrowed = [];
    const auth = [];
    const nextIndex = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$capability$2d$set$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["indexCapabilities"])(next);
    if (current === null) {
        for (const [op, tool] of nextIndex){
            added.push({
                op,
                risk: 'low',
                change: accessOf(tool) === 'write' ? 'added_write' : 'added'
            });
        }
        // Az első verzió sem vak blob-jóváhagyás: a kulcs célhostja és az auth mód
        // explicit, magas kockázatú tételként jelenik meg a jóváhagyónak.
        auth.push({
            op: 'AUTH *',
            risk: 'high',
            scope: '*',
            change: `initial_auth_mode: ${next.auth.type}/${next.authMode}`
        });
        auth.push({
            op: 'AUTH *',
            risk: 'high',
            scope: '*',
            change: `initial_base_url: ${next.baseUrl}`
        });
        auth.push({
            op: 'AUTH *',
            risk: 'high',
            scope: '*',
            change: `initial_egress_hosts: ${next.egressHosts.map((host)=>host.toLowerCase()).sort().join(',')}`
        });
        return finalize({
            added,
            breaking,
            narrowed,
            auth
        });
    }
    const currentIndex = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$capability$2d$set$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["indexCapabilities"])(current);
    // 1) Eltűnt végpontok: HASZNÁLT → breaking (magas), nem használt → narrowed (közepes).
    for (const [op] of currentIndex){
        if (nextIndex.has(op)) continue;
        const refs = usedBy(usedByResolver, op);
        if (refs && refs.length > 0) {
            breaking.push({
                op,
                risk: 'high',
                change: 'removed',
                usedBy: refs
            });
        } else {
            narrowed.push({
                op,
                risk: 'medium',
                change: 'removed'
            });
        }
    }
    // 2) Új végpontok: additív (alacsony).
    for (const [op, tool] of nextIndex){
        if (currentIndex.has(op)) continue;
        added.push({
            op,
            risk: 'low',
            change: accessOf(tool) === 'write' ? 'added_write' : 'added'
        });
    }
    // 3) Megmaradt végpontok mezőváltozásai.
    for (const [op, nextTool] of nextIndex){
        const currentTool = currentIndex.get(op);
        if (!currentTool) continue;
        // 3a) Egy fejléc kötelezővé vált (Idempotency-Key) → AUTH kategória (magas).
        //     A runtime ekkor minden írási híváshoz kötelezően fejlécet injektál — ha egy
        //     folyamat erre nem készült fel, az érintheti. A használók listáját is hozzuk.
        if (nextTool.idempotent === true && currentTool.idempotent !== true) {
            auth.push({
                op,
                risk: 'high',
                change: 'header_now_required: Idempotency-Key',
                scope: op,
                usedBy: usedBy(usedByResolver, op)
            });
        }
        // 3b) A hozzáférési szint szigorodott (read → write) — a partner ugyanazt az utat
        //     most mutálóként deklarálja. Törésveszélyes a rá épülő folyamatokra (magas).
        if (accessOf(currentTool) === 'read' && accessOf(nextTool) === 'write') {
            breaking.push({
                op,
                risk: 'high',
                change: 'access_narrowed: read_to_write',
                usedBy: usedBy(usedByResolver, op)
            });
        }
        const currentPagination = currentTool.pagination;
        const nextPagination = nextTool.pagination;
        if (canonicalJson(currentPagination) !== canonicalJson(nextPagination)) {
            if (!currentPagination && nextPagination) {
                added.push({
                    op,
                    risk: 'low',
                    change: 'pagination_declared'
                });
            } else {
                breaking.push({
                    op,
                    risk: 'high',
                    change: 'pagination_changed',
                    usedBy: usedBy(usedByResolver, op)
                });
            }
        }
        // 3c) Paraméter-kontraktus: új kötelező vagy típusváltozás breaking;
        // opcionális bővítés additív; eltűnés használattól függően breaking/narrowed.
        const currentParams = parameterIndex(currentTool);
        const nextParams = parameterIndex(nextTool);
        for (const [key, nextParam] of nextParams){
            const currentParam = currentParams.get(key);
            const label = `${nextParam.in} ${nextParam.name}`;
            if (!currentParam) {
                const item = {
                    op,
                    risk: nextParam.required ? 'high' : 'low',
                    change: nextParam.required ? `required_param_added: ${label}` : `optional_param_added${nextTool.access === 'write' ? '_write' : ''}: ${label}`,
                    usedBy: nextParam.required ? usedBy(usedByResolver, op) : undefined
                };
                if (nextParam.required) breaking.push(item);
                else added.push(item);
                continue;
            }
            if (currentParam.type !== nextParam.type) {
                breaking.push({
                    op,
                    risk: 'high',
                    change: `param_type_changed: ${label} (${currentParam.type} -> ${nextParam.type})`,
                    usedBy: usedBy(usedByResolver, op)
                });
            }
            if (!currentParam.required && nextParam.required) {
                breaking.push({
                    op,
                    risk: 'high',
                    change: `param_now_required: ${label}`,
                    usedBy: usedBy(usedByResolver, op)
                });
            } else if (currentParam.required && !nextParam.required) {
                added.push({
                    op,
                    risk: 'low',
                    change: `required_param_relaxed: ${label}`
                });
            }
        }
        for (const [key, currentParam] of currentParams){
            if (nextParams.has(key)) continue;
            const refs = usedBy(usedByResolver, op);
            const item = {
                op,
                risk: refs?.length ? 'high' : 'medium',
                change: `param_removed: ${currentParam.in} ${currentParam.name}`,
                usedBy: refs
            };
            if (refs?.length) breaking.push(item);
            else narrowed.push(item);
        }
    }
    // 4) Kapcsolat-szintű auth-mód váltás (pl. bearer_token → oauth2) → AUTH (magas, teljes scope).
    if (canonicalJson(current.auth) !== canonicalJson(next.auth) || current.authMode !== next.authMode) {
        auth.push({
            op: 'AUTH *',
            risk: 'high',
            change: `auth_config_changed: ${current.auth?.type ?? '?'}/${current.authMode} -> ${next.auth?.type ?? '?'}/${next.authMode}`,
            scope: '*'
        });
    }
    // A partner cél-hostjának változása kulcs-exfiltrációs kockázat: sosem lehet
    // additív/no-change és sosem mehet automatikusan emberi kapu nélkül.
    if (current.baseUrl !== next.baseUrl) {
        auth.push({
            op: 'AUTH *',
            risk: 'high',
            change: `base_url_changed: ${current.baseUrl} -> ${next.baseUrl}`,
            scope: '*'
        });
    }
    const currentHosts = [
        ...current.egressHosts
    ].map((host)=>host.toLowerCase()).sort();
    const nextHosts = [
        ...next.egressHosts
    ].map((host)=>host.toLowerCase()).sort();
    if (JSON.stringify(currentHosts) !== JSON.stringify(nextHosts)) {
        auth.push({
            op: 'AUTH *',
            risk: 'high',
            change: `egress_hosts_changed: ${currentHosts.join(',')} -> ${nextHosts.join(',')}`,
            scope: '*'
        });
    }
    // 5) Privacy capability-deklaráció (APG-03, spec §11): verziózott, a változása
    //    a capability-diffben jelenik meg, így a jóváhagyás auditja is rögzíti.
    for (const key of __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$privacy$2f$connector$2d$privacy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PRIVACY_CAPABILITY_KEYS"]){
        const was = Boolean(current.privacy?.[key]);
        const now = Boolean(next.privacy?.[key]);
        if (was === now) continue;
        if (!was && now) {
            added.push({
                op: 'PRIVACY *',
                risk: 'low',
                change: `privacy_capability_added: ${key}`
            });
        } else {
            breaking.push({
                op: 'PRIVACY *',
                risk: 'high',
                change: `privacy_capability_removed: ${key}`
            });
        }
    }
    return finalize({
        added,
        breaking,
        narrowed,
        auth
    });
}
function finalize(parts) {
    const hasChanges = parts.added.length > 0 || parts.breaking.length > 0 || parts.narrowed.length > 0 || parts.auth.length > 0;
    let highest = 'none';
    const bump = (r)=>{
        const order = {
            low: 1,
            medium: 2,
            high: 3
        };
        if (highest === 'none' || order[r] > order[highest]) highest = r;
    };
    for (const list of [
        parts.added,
        parts.breaking,
        parts.narrowed,
        parts.auth
    ]){
        for (const item of list)bump(item.risk);
    }
    return {
        ...parts,
        hasChanges,
        highestRisk: highest
    };
}
function isAutoApprovable(diff, policy) {
    if (!policy?.enabled) return false;
    if (diff.breaking.length > 0 || diff.narrowed.length > 0 || diff.auth.length > 0) return false;
    if (!diff.hasChanges) return true // nincs változás — nincs mit kapuzni
    ;
    if (!policy.allowAddedWrite) {
        const hasWrite = diff.added.some((d)=>d.change === 'added_write' || d.change?.startsWith('optional_param_added_write:'));
        if (hasWrite) return false;
    }
    return true;
}
}),
"[project]/src/domain/connector-self-update/self-update-service.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "SelfUpdateError",
    ()=>SelfUpdateError,
    "SelfUpdatingConnectorService",
    ()=>SelfUpdatingConnectorService
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$spec$2d$diff$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-self-update/spec-diff.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$capability$2d$set$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-self-update/capability-set.ts [app-rsc] (ecmascript)");
;
;
class SelfUpdateError extends Error {
    code;
    constructor(code, message){
        super(message), this.code = code;
        this.name = 'SelfUpdateError';
    }
}
class SelfUpdatingConnectorService {
    repo;
    syncEngine;
    audit;
    now;
    constructor(repo, syncEngine, audit, now = ()=>new Date()){
        this.repo = repo;
        this.syncEngine = syncEngine;
        this.audit = audit;
        this.now = now;
    }
    async create(input, actor) {
        const context = await this.repo.create({
            ...input,
            tenantId: actor.tenantId,
            createdById: actor.id
        });
        try {
            if (this.repo.atomicAudit) return context;
            await this.record('connector.self_update.create', actor, context.connector.id, 'pending_approval');
        } catch (error) {
            // A create csak akkor tekinthető sikeresnek, ha az audit-hash-lánc is megkapta.
            // A friss, verzió nélküli sort kompenzáljuk; az action ezután a secretet is törli.
            await this.repo.deleteUninitialized(context.connector.id, actor.tenantId).catch(()=>{});
            throw error;
        }
        return context;
    }
    async approveUrl(connectorId, actor) {
        const ctx = await this.context(connectorId, actor);
        this.requireDifferentActor(ctx.source.createdById, actor, 'A linket másik kollégának kell jóváhagynia.');
        const at = this.now();
        const auditMetadata = this.sodMeta(actor, ctx.source.createdById);
        await this.repo.approveUrl({
            sourceId: ctx.source.id,
            connectorId,
            tenantId: actor.tenantId,
            actorId: actor.id,
            at,
            auditMetadata
        });
        if (!this.repo.atomicAudit) {
            await this.record('connector.self_update.source.approve', actor, connectorId, 'allowed', auditMetadata);
        }
    }
    async markTrusted(connectorId, actor) {
        const ctx = await this.context(connectorId, actor);
        this.requireDifferentActor(ctx.source.createdById, actor, 'A megbízható minősítést másik kollégának kell megadnia.');
        const at = this.now();
        const auditMetadata = this.sodMeta(actor, ctx.source.createdById);
        await this.repo.markTrusted({
            sourceId: ctx.source.id,
            connectorId,
            tenantId: actor.tenantId,
            actorId: actor.id,
            at,
            auditMetadata
        });
        if (!this.repo.atomicAudit) {
            await this.record('connector.self_update.trust.approve', actor, connectorId, 'allowed', auditMetadata);
        }
    }
    async updatePolicy(connectorId, policy, actor) {
        const ctx = await this.context(connectorId, actor);
        // Az MVP csak read-only addíciót enged automatikusan; write opt-in sem kapcsolható be UI/API felől.
        const safePolicy = {
            enabled: policy.enabled === true,
            allowAddedWrite: false
        };
        await this.repo.updatePolicy({
            sourceId: ctx.source.id,
            connectorId,
            tenantId: actor.tenantId,
            actorId: actor.id,
            policy: safePolicy
        });
        if (!this.repo.atomicAudit) await this.record('connector.self_update.policy.update', actor, connectorId, 'allowed', safePolicy);
    }
    async sync(connectorId, actor) {
        const ctx = await this.context(connectorId, actor);
        if (!ctx.source.urlApprovedAt) throw new SelfUpdateError('URL_NOT_APPROVED', 'A link még nincs jóváhagyva.');
        if (!ctx.source.trustedAt) throw new SelfUpdateError('PARTNER_NOT_TRUSTED', 'A partner még nincs megbízhatónak minősítve.');
        const result = await this.syncEngine.sync(ctx.source.specUrl, ctx.connector.name);
        if (!result.ok) {
            await this.record('connector.self_update.sync.failed', actor, connectorId, result.reason, {
                reason: result.reason,
                detail: result.detail ?? null,
                active_version_id: ctx.connector.activeSpecVersionId
            });
            return {
                kind: 'failed',
                reason: result.reason,
                ...result.detail ? {
                    detail: result.detail
                } : {}
            };
        }
        const current = ctx.activeVersion ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$capability$2d$set$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["parseCapabilitySet"])(ctx.activeVersion.capabilitySet) : null;
        if (ctx.activeVersion && !current) {
            throw new SelfUpdateError('INVALID_CAPABILITY_SET', 'Az aktív pillanatkép nem értelmezhető; semmi nem változott.');
        }
        const currentSchemaVersion = current?.capabilitySchemaVersion ?? 1;
        const nextSchemaVersion = result.capabilitySet.capabilitySchemaVersion ?? 1;
        if (ctx.activeVersion?.rawHash === result.rawHash && currentSchemaVersion === nextSchemaVersion) {
            await this.repo.touchSynced(ctx.source.id, this.now());
            await this.record('connector.self_update.sync.no_change', actor, connectorId, 'unchanged', {
                raw_hash: result.rawHash
            });
            return {
                kind: 'unchanged',
                activeVersionId: ctx.connector.activeSpecVersionId
            };
        }
        const existingProposal = await this.repo.findOpenProposalByHash(connectorId, actor.tenantId, result.rawHash);
        const existingProposalSet = existingProposal ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$capability$2d$set$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["parseCapabilitySet"])(existingProposal.capabilitySet) : null;
        if (existingProposal && (existingProposalSet?.capabilitySchemaVersion ?? 1) === nextSchemaVersion) {
            await this.repo.touchSynced(ctx.source.id, this.now());
            await this.record('connector.self_update.sync.no_change', actor, connectorId, 'proposal_already_exists', {
                raw_hash: result.rawHash,
                version_id: existingProposal.id
            });
            return {
                kind: 'proposed',
                version: existingProposal,
                autoApproved: false
            };
        }
        const usage = await this.repo.listUsage(connectorId, actor.tenantId);
        const diff = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$spec$2d$diff$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["computeCapabilityDiff"])(current, result.capabilitySet, (op)=>{
            const path = op.includes(' ') ? op.slice(op.indexOf(' ') + 1) : op;
            const refs = [
                ...usage[op] ?? [],
                ...usage[`PATH ${path}`] ?? [],
                ...usage['*'] ?? []
            ];
            return [
                ...new Map(refs.map((ref)=>[
                        `${ref.type}:${ref.id}`,
                        ref
                    ])).values()
            ];
        });
        const fetchedAt = this.now();
        const version = await this.repo.createProposal({
            connectorId,
            tenantId: actor.tenantId,
            rawSnapshot: result.rawText,
            rawHash: result.rawHash,
            capabilitySet: result.capabilitySet,
            diffFromVersionId: ctx.activeVersion?.id ?? null,
            diffSummary: diff,
            fetchedAt,
            actorId: actor.id
        });
        await this.repo.touchSynced(ctx.source.id, fetchedAt);
        const autoApproved = Boolean(ctx.activeVersion && ctx.tenantAutoApproveEnabled && (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$spec$2d$diff$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isAutoApprovable"])(diff, ctx.source.autoApprovePolicy));
        const finalVersion = autoApproved ? await this.repo.activateVersion({
            connectorId,
            tenantId: actor.tenantId,
            versionId: version.id,
            approvedById: null,
            approvedAt: fetchedAt,
            actorId: actor.id
        }) : version;
        if (!this.repo.atomicAudit) await this.record(autoApproved ? 'connector.self_update.version.auto_approve' : 'connector.self_update.sync.proposed', autoApproved ? null : actor, connectorId, autoApproved ? 'auto_approved' : 'human_approval_required', {
            version_id: version.id,
            version_no: version.versionNo,
            diff
        }, actor.tenantId);
        return {
            kind: 'proposed',
            version: finalVersion,
            autoApproved
        };
    }
    async approveVersion(connectorId, versionId, actor) {
        const ctx = await this.context(connectorId, actor);
        if (!ctx.source.trustedAt || !ctx.source.urlApprovedAt) {
            throw new SelfUpdateError('INVALID_STATE', 'A link és a partner jóváhagyása szükséges.');
        }
        // T2 SoD: a link beállítója EGYETLEN capability-verziót sem élesíthet egyedül —
        // sem az elsőt, sem a későbbi bővítéseket. A rendszer épp a kockázatos (pl. új
        // írási) változásokat tartja vissza az automatikus átvételtől, hogy emberi kapun
        // menjenek át; ez a kapu csak akkor ér valamit, ha a jóváhagyó más, mint a beállító.
        // Superadmin (sodExempt) továbbra is kivétel — auditált `sod_bypass` metaadattal.
        this.requireDifferentActor(ctx.source.createdById, actor, ctx.activeVersion ? 'A módosítást másik kollégának kell átvennie, mint aki a linket beállította.' : 'Az első verziót nem hagyhatja jóvá a link beállítója.');
        const sod = this.sodMeta(actor, ctx.source.createdById);
        const version = await this.repo.activateVersion({
            connectorId,
            tenantId: actor.tenantId,
            versionId,
            approvedById: actor.id,
            approvedAt: this.now(),
            actorId: actor.id,
            auditMetadata: sod
        });
        if (!this.repo.atomicAudit) await this.record('connector.self_update.version.approve', actor, connectorId, 'allowed', {
            version_id: version.id,
            version_no: version.versionNo,
            previous_version_id: ctx.activeVersion?.id ?? null,
            ...sod
        });
        return version;
    }
    async rejectVersion(connectorId, versionId, actor) {
        await this.context(connectorId, actor);
        const version = await this.repo.rejectVersion({
            connectorId,
            tenantId: actor.tenantId,
            versionId,
            actorId: actor.id
        });
        if (!this.repo.atomicAudit) await this.record('connector.self_update.version.reject', actor, connectorId, 'rejected', {
            version_id: version.id,
            version_no: version.versionNo
        });
        return version;
    }
    async rollback(connectorId, targetVersionId, actor) {
        const ctx = await this.context(connectorId, actor);
        if (ctx.connector.activeSpecVersionId === targetVersionId) {
            throw new SelfUpdateError('INVALID_STATE', 'Ez a verzió már jelenleg is aktív.');
        }
        const version = await this.repo.rollback({
            connectorId,
            tenantId: actor.tenantId,
            targetVersionId,
            actorId: actor.id,
            at: this.now()
        });
        if (!this.repo.atomicAudit) await this.record('connector.self_update.version.rollback', actor, connectorId, 'allowed', {
            from_version_id: ctx.connector.activeSpecVersionId,
            to_version_id: version.id,
            to_version_no: version.versionNo
        });
        return version;
    }
    async detail(connectorId, actor) {
        const context = await this.context(connectorId, actor);
        const versions = await this.repo.listVersions(connectorId, actor.tenantId);
        return {
            context,
            versions
        };
    }
    async context(connectorId, actor) {
        const ctx = await this.repo.findContext(connectorId, actor.tenantId);
        if (!ctx) throw new SelfUpdateError('NOT_FOUND', 'Az OpenAPI-kapcsolat nem található.');
        if (ctx.connector.tenantId !== actor.tenantId || ctx.source.tenantId !== actor.tenantId) {
            throw new SelfUpdateError('TENANT_ISOLATION', 'A kapcsolat nem érhető el ebben a tenantban.');
        }
        return ctx;
    }
    requireDifferentActor(configuredById, actor, message) {
        if (configuredById === actor.id && !actor.sodExempt) {
            throw new SelfUpdateError('SEPARATION_OF_DUTIES', message);
        }
    }
    sodMeta(actor, configuredById) {
        if (configuredById === actor.id && actor.sodExempt) return {
            sod_bypass: 'superadmin'
        };
        return undefined;
    }
    async record(action, actor, connectorId, policyDecision, metadata, tenantId) {
        await this.audit.append({
            action,
            actorId: actor?.id ?? null,
            tenantId: actor?.tenantId ?? tenantId,
            connectorId,
            policyDecision,
            metadata
        });
    }
}
}),
"[project]/src/domain/connector-self-update/tenant-settings.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "SELF_UPDATE_AUTO_APPROVE_SETTING",
    ()=>SELF_UPDATE_AUTO_APPROVE_SETTING,
    "tenantSelfUpdateAutoApproveEnabled",
    ()=>tenantSelfUpdateAutoApproveEnabled,
    "withTenantSelfUpdateAutoApprove",
    ()=>withTenantSelfUpdateAutoApprove
]);
const SELF_UPDATE_AUTO_APPROVE_SETTING = 'selfUpdatingConnectorsAutoApproveEnabled';
function settingsRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function tenantSelfUpdateAutoApproveEnabled(settings) {
    return settingsRecord(settings)[SELF_UPDATE_AUTO_APPROVE_SETTING] === true;
}
function withTenantSelfUpdateAutoApprove(settings, enabled) {
    return {
        ...settingsRecord(settings),
        [SELF_UPDATE_AUTO_APPROVE_SETTING]: enabled
    };
}
}),
"[externals]/crypto [external] (crypto, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("crypto", () => require("crypto"));

module.exports = mod;
}),
"[project]/src/lib/crypto/secret-resolver.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "resolveSecret",
    ()=>resolveSecret
]);
/**
 * Fail-closed titok-feloldás (Architektúra-review F1 / WP-1).
 *
 * Egyetlen, központi feloldó, hogy a "prod alatt kötelező az env" minta ne
 * szóródjon szét a hívóhelyekre. Prod alatt env hiányában a folyamat
 * induláskor (import-időben) leáll — így élesben SOHA nem futhat a nyilvános,
 * hamisítható dev-default titokkal. Nem-prod alatt determinisztikus dev-defaultot
 * ad vissza, de figyelmeztet.
 *
 * A NODE_ENV-et szándékosan a függvényen belül olvassuk (nem modul-szintű
 * konstansként), hogy a feloldó egységtesztelhető legyen a prod- és a
 * dev-ágra egyaránt.
 */ /**
 * A dev-default titkok közös utótagja. Ezek az értékek a repóban publikáltak, ezért
 * prod alatt env-ként beállítva is hamisíthatók — a puszta "van env" nem elég.
 */ const PLACEHOLDER_MARKER = 'change-in-prod';
function resolveSecret(names, devDefault) {
    const isProd = ("TURBOPACK compile-time value", "development") === 'production';
    for (const n of names){
        const v = process.env[n];
        if (!v || v.length === 0) continue;
        // Prod alatt a publikált placeholder beállítva sem valódi titok: fail-closed.
        if (isProd && v.includes(PLACEHOLDER_MARKER)) //TURBOPACK unreachable
        ;
        return v;
    }
    if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
    ;
    console.warn(`[secret-resolver] DEV default használatban: ${names[0]} (NE használd prod-ban)`);
    return devDefault;
}
}),
"[project]/src/lib/crypto/hash-chain.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "AUDIT_HASH_VERSION",
    ()=>AUDIT_HASH_VERSION,
    "GENESIS_HASH",
    ()=>GENESIS_HASH,
    "computeAuditHash",
    ()=>computeAuditHash,
    "computeAuditHashV2",
    ()=>computeAuditHashV2,
    "computeDiffHash",
    ()=>computeDiffHash,
    "generateTokenPair",
    ()=>generateTokenPair,
    "hashOpaqueToken",
    ()=>hashOpaqueToken,
    "parseAuditHashVersion",
    ()=>parseAuditHashVersion,
    "signSkillVersion",
    ()=>signSkillVersion,
    "signWriteGateToken",
    ()=>signWriteGateToken,
    "verifySkillVersionSignature",
    ()=>verifySkillVersionSignature,
    "verifyWriteGateSignature",
    ()=>verifyWriteGateSignature
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/crypto [external] (crypto, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$crypto$2f$secret$2d$resolver$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/crypto/secret-resolver.ts [app-rsc] (ecmascript)");
;
;
const GENESIS_HASH = '0'.repeat(64);
const AUDIT_HASH_VERSION = 2;
const AUDIT_HASH_V2_PREFIX = `${AUDIT_HASH_VERSION}:`;
function parseAuditHashVersion(storedHash) {
    return storedHash.startsWith(AUDIT_HASH_V2_PREFIX) ? 2 : 1;
}
function computeAuditHash(params) {
    const canonical = JSON.stringify({
        seq: params.seq.toString(),
        prevHash: params.prevHash,
        actorType: params.actorType,
        actorId: params.actorId ?? '',
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId ?? '',
        createdAt: params.createdAt.toISOString()
    });
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createHash"])('sha256').update(canonical, 'utf8').digest('hex');
}
/**
 * A `metadata` double-jei NEM utaznak veszteségmentesen a DB-be: a Prisma a `Json` mező
 * írásakor 16 értékes jegyre kerekít (0.13781565621305947 → 0.1378156562130595). A hash-t
 * viszont a memóriabeli, teljes pontosságú értékre számoltuk, így a verifyChain a
 * visszaolvasott (kerekített) értékből sosem kaphatta vissza az eredeti hash-t, és saját
 * magára mondott tampert — a `memory.retrieve` sorokra, amik hasonlósági score-t tesznek a
 * metaadatba (egy double ~30%-ának kell 17 jegy).
 *
 * A hash annak a sornak a bizonyítéka, ami a DB-ben ÁLL, ezért a normalizálás mindkét
 * oldalon (íráskor és ellenőrzéskor) fut. Így a lánc konzisztens marad attól függetlenül,
 * hogy a szerializáló kerekít-e — egy jövőbeli Prisma, ami pontosan írna, sem törné el.
 * ≤16 jegyű értékekre identitás, ezért a MEGLÉVŐ sorok hash-e változatlan (nincs v3/migráció).
 */ const AUDIT_NUMBER_PRECISION = 16;
function normalizeNumber(value) {
    // A nem-véges értékeket (NaN/Infinity) a JSON.stringify amúgy is null-ra viszi.
    return Number.isFinite(value) ? Number(value.toPrecision(AUDIT_NUMBER_PRECISION)) : value;
}
/**
 * Determinisztikus, kulcs-sorrendtől független kanonikalizálás. A `metadata` a DB-ben
 * `jsonb`, ami NEM őrzi meg a kulcs-sorrendet; a rekurzív kulcsrendezés biztosítja, hogy
 * az írás-idejű (JS objektum) és az ellenőrzés-idejű (jsonb-ból visszaolvasott) forma
 * ugyanazt a kanonikus stringet adja.
 */ function canonicalizeJson(value) {
    if (typeof value === 'number') return normalizeNumber(value);
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalizeJson);
    const obj = value;
    return Object.keys(obj).sort().reduce((acc, key)=>{
        acc[key] = canonicalizeJson(obj[key]);
        return acc;
    }, {});
}
function computeAuditHashV2(params) {
    const canonical = JSON.stringify({
        v: AUDIT_HASH_VERSION,
        seq: params.seq.toString(),
        prevHash: params.prevHash,
        actorType: params.actorType,
        actorId: params.actorId ?? '',
        agentVersion: params.agentVersion ?? null,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId ?? '',
        modelUsed: params.modelUsed ?? '',
        inputRef: params.inputRef ?? '',
        outputRef: params.outputRef ?? '',
        policyDecision: params.policyDecision ?? '',
        metadata: params.metadata == null ? null : canonicalizeJson(params.metadata),
        tenantId: params.tenantId ?? '',
        ticketId: params.ticketId ?? '',
        conversationId: params.conversationId ?? '',
        createdAt: params.createdAt.toISOString()
    });
    return AUDIT_HASH_V2_PREFIX + (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createHash"])('sha256').update(canonical, 'utf8').digest('hex');
}
// ── Write-gate token crypto ───────────────────────────────────────────────
const WRITE_GATE_SECRET = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$crypto$2f$secret$2d$resolver$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["resolveSecret"])([
    'WRITE_GATE_SECRET'
], 'dev-write-gate-secret-change-in-prod');
function computeDiffHash(content) {
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createHash"])('sha256').update(content, 'utf8').digest('hex');
}
function hashOpaqueToken(rawToken) {
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createHash"])('sha256').update(rawToken, 'hex').digest('hex');
}
function generateTokenPair() {
    const rawToken = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["randomBytes"])(32).toString('hex');
    const tokenHash = hashOpaqueToken(rawToken);
    return {
        rawToken,
        tokenHash
    };
}
function signWriteGateToken(params) {
    const msg = [
        params.tokenHash,
        params.expectedDiffHash,
        params.subjectId,
        params.expiresAt.toISOString()
    ].join(':');
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createHmac"])('sha256', WRITE_GATE_SECRET).update(msg).digest('hex');
}
function signSkillVersion(params) {
    const msg = [
        'skill',
        params.skillVersionId,
        params.contentHash,
        params.approverId
    ].join(':');
    return (0, __TURBOPACK__imported__module__$5b$externals$5d2f$crypto__$5b$external$5d$__$28$crypto$2c$__cjs$29$__["createHmac"])('sha256', WRITE_GATE_SECRET).update(msg).digest('hex');
}
function verifySkillVersionSignature(params) {
    const expected = signSkillVersion(params);
    try {
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(params.signature, 'hex');
        if (a.length !== b.length) return false;
        let diff = 0;
        for(let i = 0; i < a.length; i++)diff |= a[i] ^ b[i];
        return diff === 0;
    } catch  {
        return false;
    }
}
function verifyWriteGateSignature(params) {
    const expected = signWriteGateToken(params);
    // constant-time comparison
    try {
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(params.signature, 'hex');
        if (a.length !== b.length) return false;
        let diff = 0;
        for(let i = 0; i < a.length; i++)diff |= a[i] ^ b[i];
        return diff === 0;
    } catch  {
        return false;
    }
}
}),
"[project]/src/lib/audit/payload-guard.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "UnsafeAuditPayloadError",
    ()=>UnsafeAuditPayloadError,
    "assertAuditMetadataSafe",
    ()=>assertAuditMetadataSafe
]);
/**
 * Content/metadata szétválasztás kódszintű őre (Feature-spec AuditLog-Observability §2/5, §4.1/1).
 * Nyers üzenet-, PII-, dokumentum-, argumentum- vagy secret-tartalom SOHA nem kerülhet az
 * audit_log.metadata mezőbe — csak referencia (*_ref/*_hash/*_alias) vagy kis méretű metaadat.
 */ const MAX_AUDIT_STRING_LENGTH = 4096;
const FORBIDDEN_METADATA_KEYS = new Set([
    'authorization',
    'body',
    'content',
    'cookie',
    'message',
    'password',
    'prompt',
    'raw',
    'reason',
    'response',
    'secret',
    'text',
    'token',
    'tokenref'
]);
// Ezek a kulcsok a tiltólista szavait tartalmazhatják, de a spec engedélyezett ref/hash/alias
// formájúak (pl. contentRef, secretAlias, tokenHash) — nem nyers tartalom.
const ALLOWED_REF_SUFFIX_KEYS = new Set([
    'contenthash',
    'contentref',
    'diffhash',
    'inputref',
    'messageref',
    'outputref',
    'queryhash',
    'secretalias',
    'sourcehash',
    'storageref',
    'tokenhash'
]);
function normalizeKey(key) {
    return key.replace(/[_-]/g, '').toLowerCase();
}
class UnsafeAuditPayloadError extends Error {
    constructor(path){
        super(`Unsafe audit payload: "${path}" must be stored as a ref/hash/meta field, not raw content`);
        this.name = 'UnsafeAuditPayloadError';
    }
}
function assertAuditMetadataSafe(value, path = 'metadata') {
    if (value == null) return;
    if (typeof value === 'string') {
        if (value.length > MAX_AUDIT_STRING_LENGTH) {
            throw new UnsafeAuditPayloadError(path);
        }
        return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((item, index)=>assertAuditMetadataSafe(item, `${path}[${index}]`));
        return;
    }
    for (const [key, child] of Object.entries(value)){
        const normalized = normalizeKey(key);
        if (FORBIDDEN_METADATA_KEYS.has(normalized) && !ALLOWED_REF_SUFFIX_KEYS.has(normalized)) {
            throw new UnsafeAuditPayloadError(`${path}.${key}`);
        }
        assertAuditMetadataSafe(child, `${path}.${key}`);
    }
}
}),
"[project]/src/lib/audit/event-catalog.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * Kötelező eseménytípus-katalógus. Minden `AuditRepository.append()` `action`
 * mezője itt kell legyen — ismeretlen típus fail-fast.
 *
 * Phase F: a lista a live `app/` writer-ekre van nyesve (nincs chat/ticket/sín).
 */ __turbopack_context__.s([
    "CORE_MVP_AUDIT_ACTIONS",
    ()=>CORE_MVP_AUDIT_ACTIONS,
    "REGISTERED_AUDIT_ACTIONS",
    ()=>REGISTERED_AUDIT_ACTIONS,
    "UnregisteredAuditActionError",
    ()=>UnregisteredAuditActionError,
    "assertAuditActionRegistered",
    ()=>assertAuditActionRegistered
]);
const CORE_MVP_AUDIT_ACTIONS = [
    'mcp.auth.ok',
    'mcp.auth.deny',
    'mcp.tools.call',
    'mcp.tools.call.deny',
    'mcp.resources.read',
    'mcp.prompts.get',
    'enterprise.tool.ok',
    'enterprise.tool.denied',
    'enterprise.tool.error',
    'gateway.operation.enqueued',
    'gateway.operation.approved',
    'gateway.operation.rejected',
    'gateway.operation.executing',
    'gateway.operation.succeeded',
    'gateway.operation.failed',
    'gateway.operation.confirm_mismatch'
];
const REGISTERED_AUDIT_ACTIONS = new Set([
    ...CORE_MVP_AUDIT_ACTIONS,
    'user.authz.deny',
    'user.invite.issue',
    'user.invite.redeem',
    'user.invite.revoke',
    'user.permission.update',
    'user.provision.claim',
    'user.provision.create',
    'user.reactivate',
    'user.role.assign',
    'user.role.change',
    'user.agent_access.update',
    'user.suspend',
    'platform.role.grant',
    'platform.role.revoke',
    'tenant.create',
    'tenant.suspend',
    'tenant.offboard',
    'tenant.archive',
    'tenant.reactivate',
    'tenant.assume',
    'tenant.switch',
    'tenant.exit',
    'tenant.member.add',
    'tenant.member.update',
    'tenant.member.role.change',
    'tenant.member.suspend',
    'tenant.member.invite_accept',
    'agent.create',
    'agent.activated',
    'agent.version',
    'agent.delete',
    'agent.profile',
    'agent.memory_write_mode',
    'agent.output_folder',
    'agent.user.grant',
    'agent.user.revoke',
    'provisioning.access_denied',
    'provisioning.connector.activate',
    'provisioning.connector.assign',
    'provisioning.connector.decommission',
    'provisioning.connector.reopen',
    'provisioning.connector.unassign',
    'provisioning.draft.create',
    'provisioning.draft.delete',
    'provisioning.draft.reject',
    'provisioning.draft.review',
    'provisioning.draft.update',
    'provisioning.draft.validate',
    'provisioning.doc.fetch',
    'provisioning.doc.fetch.blocked',
    'connector.egress_allowlist.extend',
    'connector.materialize',
    'connector.agentmail.org_key.set',
    'connector.agentmail.inbox.create',
    'connector.template.create',
    'connector.template.deprecate',
    'connector.self_update.create',
    'connector.self_update.source.approve',
    'connector.self_update.trust.approve',
    'connector.self_update.policy.update',
    'connector.self_update.sync.proposed',
    'connector.self_update.sync.failed',
    'connector.self_update.sync.no_change',
    'connector.self_update.version.approve',
    'connector.self_update.version.auto_approve',
    'connector.self_update.version.reject',
    'connector.self_update.version.rollback',
    'connector.self_update.api_key.rotate',
    'tenant.self_update.policy.update',
    'privacy.connector.capability.absent',
    'privacy.connector.capability.changed',
    'kb.document.ingested',
    'kb.document.deleted',
    'kb.catalog.attached',
    'skill.conversation.created',
    'skill.conversation.proposed',
    'skill.conversation.proposal.overwritten',
    'skill.conversation.approved',
    'skill.conversation.rejected',
    'project.create',
    'project.work_file.write',
    'project.work_file.delete',
    'project.project_memory.write',
    'handoff.created',
    'handoff.acknowledged'
]);
class UnregisteredAuditActionError extends Error {
    constructor(action){
        super(`Unregistered audit action: ${action}`);
        this.name = 'UnregisteredAuditActionError';
    }
}
function assertAuditActionRegistered(action) {
    if (!REGISTERED_AUDIT_ACTIONS.has(action)) {
        throw new UnregisteredAuditActionError(action);
    }
}
}),
"[project]/src/lib/audit/attribution.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "deriveAuditAttribution",
    ()=>deriveAuditAttribution
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readUuidField(metadata, keys) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const obj = metadata;
    for (const key of keys){
        const value = obj[key];
        if (typeof value === 'string' && UUID_RE.test(value)) return value;
    }
    return null;
}
function deriveAuditAttribution(data) {
    const tenantId = data.tenantId ?? (data.targetType === 'tenant' ? data.targetId ?? null : null) ?? readUuidField(data.metadata, [
        'tenantId',
        'tenant_id'
    ]);
    return {
        tenantId: tenantId ?? null
    };
}
}),
"[project]/src/repositories/postgres/audit-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresAuditRepository",
    ()=>PostgresAuditRepository,
    "appendAuditInTransaction",
    ()=>appendAuditInTransaction
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$crypto$2f$hash$2d$chain$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/crypto/hash-chain.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audit$2f$payload$2d$guard$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/audit/payload-guard.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audit$2f$event$2d$catalog$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/audit/event-catalog.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audit$2f$attribution$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/audit/attribution.ts [app-rsc] (ecmascript)");
;
;
;
;
;
const AUDIT_CHAIN_LOCK_KEY = 424242;
const AUDIT_WALK_MAX = 100_000;
async function appendAuditInTransaction(tx, data) {
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audit$2f$event$2d$catalog$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["assertAuditActionRegistered"])(data.action);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audit$2f$payload$2d$guard$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["assertAuditMetadataSafe"])(data.metadata);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;
    const [{ nextval: seq }] = await tx.$queryRaw`
    SELECT nextval('audit_log_seq_seq') AS nextval
  `;
    const last = await tx.auditLog.findFirst({
        orderBy: {
            seq: 'desc'
        }
    });
    const prevHash = last?.hash ?? __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$crypto$2f$hash$2d$chain$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["GENESIS_HASH"];
    const createdAt = new Date();
    const attribution = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$audit$2f$attribution$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["deriveAuditAttribution"])(data);
    const hash = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$crypto$2f$hash$2d$chain$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["computeAuditHashV2"])({
        seq,
        prevHash,
        actorType: data.actorType,
        actorId: data.actorId ?? null,
        agentVersion: data.agentVersion ?? null,
        action: data.action,
        targetType: data.targetType,
        targetId: data.targetId ?? null,
        modelUsed: data.modelUsed ?? null,
        inputRef: data.inputRef ?? null,
        outputRef: data.outputRef ?? null,
        policyDecision: data.policyDecision ?? null,
        metadata: data.metadata,
        tenantId: attribution.tenantId,
        ticketId: null,
        conversationId: null,
        createdAt
    });
    return tx.auditLog.create({
        data: {
            actorType: data.actorType,
            actorId: data.actorId ?? null,
            agentVersion: data.agentVersion ?? null,
            action: data.action,
            targetType: data.targetType,
            targetId: data.targetId ?? null,
            modelUsed: data.modelUsed ?? null,
            inputRef: data.inputRef ?? null,
            outputRef: data.outputRef ?? null,
            policyDecision: data.policyDecision ?? null,
            metadata: data.metadata === undefined ? undefined : data.metadata,
            tenantId: attribution.tenantId,
            seq,
            prevHash,
            hash,
            createdAt
        }
    });
}
class PostgresAuditRepository {
    /**
   * Egyetlen belépési pont az audit_log-ba. A hash-t INSERT ELŐTT számítjuk
   * (nextval a seq-sequence-ről az advisory lock alatt), így a sor egy atomi
   * INSERT-tel jön létre — nincs utólagos UPDATE.
   */ async append(data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction((tx)=>appendAuditInTransaction(tx, data), {
            timeout: 60_000
        });
    }
    async findMany(filter) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].auditLog.findMany({
            where: {
                ...filter?.action ? {
                    action: Array.isArray(filter.action) ? {
                        in: filter.action
                    } : filter.action
                } : {},
                ...filter?.actorType ? {
                    actorType: filter.actorType
                } : {},
                ...filter?.actorId ? {
                    actorId: filter.actorId
                } : {},
                ...filter?.targetType ? {
                    targetType: filter.targetType
                } : {},
                ...filter?.targetId ? {
                    targetId: filter.targetId
                } : {},
                ...filter?.tenantId ? {
                    tenantId: filter.tenantId
                } : {},
                ...filter?.since || filter?.until ? {
                    createdAt: {
                        ...filter?.since ? {
                            gte: filter.since
                        } : {},
                        ...filter?.until ? {
                            lte: filter.until
                        } : {}
                    }
                } : {}
            },
            orderBy: {
                seq: filter?.order ?? 'desc'
            },
            take: filter?.limit ?? 100
        });
    }
    async findAll(filter) {
        const seqFilter = {};
        if (filter?.fromSeq !== undefined) seqFilter.gte = filter.fromSeq;
        if (filter?.toSeq !== undefined) seqFilter.lte = filter.toSeq;
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].auditLog.findMany({
            where: {
                ...Object.keys(seqFilter).length > 0 ? {
                    seq: seqFilter
                } : {},
                ...filter?.tenantId ? {
                    tenantId: filter.tenantId
                } : {},
                ...filter?.since ? {
                    createdAt: {
                        gte: filter.since
                    }
                } : {}
            },
            orderBy: {
                seq: 'asc'
            },
            take: filter?.limit ?? AUDIT_WALK_MAX
        });
    }
    async listHashChain(filter) {
        const seqFilter = {};
        if (filter?.fromSeq !== undefined) seqFilter.gte = filter.fromSeq;
        if (filter?.toSeq !== undefined) seqFilter.lte = filter.toSeq;
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].auditLog.findMany({
            where: Object.keys(seqFilter).length > 0 ? {
                seq: seqFilter
            } : {},
            orderBy: {
                seq: 'asc'
            },
            select: {
                seq: true,
                hash: true
            },
            take: AUDIT_WALK_MAX
        });
    }
    async getActionCounts(filter) {
        const grouped = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].auditLog.groupBy({
            by: [
                'action'
            ],
            where: {
                ...filter?.actions ? {
                    action: {
                        in: filter.actions
                    }
                } : {},
                ...filter?.since ? {
                    createdAt: {
                        gte: filter.since
                    }
                } : {}
            },
            _count: {
                _all: true
            }
        });
        const counts = {};
        if (filter?.actions) {
            for (const action of filter.actions)counts[action] = 0;
        }
        for (const row of grouped)counts[row.action] = row._count._all;
        return counts;
    }
}
}),
"[project]/src/repositories/postgres/self-updating-connector-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresSelfUpdatingConnectorRepository",
    ()=>PostgresSelfUpdatingConnectorRepository
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__ = __turbopack_context__.i("[externals]/@prisma/client [external] (@prisma/client, cjs, [project]/node_modules/@prisma/client)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-self-update/self-update-service.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$tenant$2d$settings$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/domain/connector-self-update/tenant-settings.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/audit-repository.ts [app-rsc] (ecmascript)");
;
;
;
;
;
function connectorAudit(input) {
    return {
        actorType: input.actorId ? 'human' : 'system',
        actorId: input.actorId,
        agentVersion: null,
        action: input.action,
        targetType: 'connector',
        targetId: input.connectorId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: input.policyDecision,
        tenantId: input.tenantId,
        metadata: {
            tenant_id: input.tenantId,
            ...input.metadata ?? {}
        }
    };
}
function policyOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value;
    return {
        enabled: raw.enabled === true,
        allowAddedWrite: raw.allowAddedWrite === true
    };
}
function versionOf(row) {
    return {
        id: row.id,
        connectorId: row.connectorId,
        tenantId: row.tenantId,
        versionNo: row.versionNo,
        rawHash: row.rawHash,
        capabilitySet: row.capabilitySet,
        status: row.status,
        diffFromVersionId: row.diffFromVersionId,
        diffSummary: row.diffSummary,
        fetchedAt: row.fetchedAt,
        approvedById: row.approvedById,
        approvedAt: row.approvedAt
    };
}
function sourceOf(row) {
    return {
        id: row.id,
        connectorId: row.connectorId,
        tenantId: row.tenantId,
        specUrl: row.specUrl,
        createdById: row.createdById,
        urlApprovedById: row.urlApprovedById,
        urlApprovedAt: row.urlApprovedAt,
        trustedById: row.trustedById,
        trustedAt: row.trustedAt,
        autoApprovePolicy: policyOf(row.autoApprovePolicy),
        lastSyncedAt: row.lastSyncedAt
    };
}
function addUsage(target, keys, ref) {
    for (const key of keys){
        const list = target[key] ??= [];
        if (!list.some((entry)=>entry.type === ref.type && entry.id === ref.id)) list.push(ref);
    }
}
class PostgresSelfUpdatingConnectorRepository {
    atomicAudit = true;
    async create(input) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const created = await tx.connector.create({
                data: {
                    ...input.connectorId ? {
                        id: input.connectorId
                    } : {},
                    tenant: {
                        connect: {
                            id: input.tenantId
                        }
                    },
                    name: input.name,
                    type: 'http_api',
                    authMode: 'service',
                    scope: 'single',
                    lifecycleState: 'active',
                    connectorMode: 'self_updating',
                    secretAlias: input.secretAlias ?? null,
                    config: {},
                    specSource: {
                        create: {
                            tenantId: input.tenantId,
                            specUrl: input.specUrl,
                            specFormat: 'openapi_3',
                            createdById: input.createdById
                        }
                    }
                },
                include: {
                    specSource: true
                }
            });
            await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["appendAuditInTransaction"])(tx, connectorAudit({
                action: 'connector.self_update.create',
                actorId: input.createdById,
                tenantId: input.tenantId,
                connectorId: created.id,
                policyDecision: 'pending_approval'
            }));
            return created;
        }, {
            timeout: 60_000
        });
        const tenant = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenant.findUnique({
            where: {
                id: input.tenantId
            },
            select: {
                settings: true
            }
        });
        return {
            connector: {
                id: row.id,
                tenantId: input.tenantId,
                name: row.name,
                activeSpecVersionId: null
            },
            source: sourceOf(row.specSource),
            activeVersion: null,
            tenantAutoApproveEnabled: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$tenant$2d$settings$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["tenantSelfUpdateAutoApproveEnabled"])(tenant?.settings)
        };
    }
    async deleteUninitialized(connectorId, tenantId) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.deleteMany({
            where: {
                id: connectorId,
                tenantId,
                connectorMode: 'self_updating',
                activeSpecVersionId: null,
                specVersions: {
                    none: {}
                }
            }
        });
    }
    async findContext(connectorId, tenantId) {
        const [row, tenant] = await Promise.all([
            __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connector.findFirst({
                where: {
                    id: connectorId,
                    tenantId,
                    connectorMode: 'self_updating'
                },
                include: {
                    specSource: true,
                    activeSpecVersion: true
                }
            }),
            __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenant.findUnique({
                where: {
                    id: tenantId
                },
                select: {
                    settings: true
                }
            })
        ]);
        if (!row?.specSource) return null;
        return {
            connector: {
                id: row.id,
                tenantId,
                name: row.name,
                activeSpecVersionId: row.activeSpecVersionId
            },
            source: sourceOf(row.specSource),
            activeVersion: row.activeSpecVersion ? versionOf(row.activeSpecVersion) : null,
            tenantAutoApproveEnabled: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$tenant$2d$settings$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["tenantSelfUpdateAutoApproveEnabled"])(tenant?.settings)
        };
    }
    async approveUrl(input) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const updated = await tx.connectorSpecSource.updateMany({
                where: {
                    id: input.sourceId,
                    connectorId: input.connectorId,
                    tenantId: input.tenantId
                },
                data: {
                    urlApprovedById: input.actorId,
                    urlApprovedAt: input.at
                }
            });
            if (updated.count !== 1) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('NOT_FOUND', 'Az OpenAPI-kapcsolat nem található.');
            await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["appendAuditInTransaction"])(tx, connectorAudit({
                action: 'connector.self_update.source.approve',
                actorId: input.actorId,
                tenantId: input.tenantId,
                connectorId: input.connectorId,
                policyDecision: 'allowed',
                metadata: input.auditMetadata
            }));
        }, {
            timeout: 60_000
        });
    }
    async markTrusted(input) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const updated = await tx.connectorSpecSource.updateMany({
                where: {
                    id: input.sourceId,
                    connectorId: input.connectorId,
                    tenantId: input.tenantId
                },
                data: {
                    trustedById: input.actorId,
                    trustedAt: input.at
                }
            });
            if (updated.count !== 1) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('NOT_FOUND', 'Az OpenAPI-kapcsolat nem található.');
            await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["appendAuditInTransaction"])(tx, connectorAudit({
                action: 'connector.self_update.trust.approve',
                actorId: input.actorId,
                tenantId: input.tenantId,
                connectorId: input.connectorId,
                policyDecision: 'allowed',
                metadata: input.auditMetadata
            }));
        }, {
            timeout: 60_000
        });
    }
    async updatePolicy(input) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const updated = await tx.connectorSpecSource.updateMany({
                where: {
                    id: input.sourceId,
                    connectorId: input.connectorId,
                    tenantId: input.tenantId
                },
                data: {
                    autoApprovePolicy: input.policy
                }
            });
            if (updated.count !== 1) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('NOT_FOUND', 'Az OpenAPI-kapcsolat nem található.');
            await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["appendAuditInTransaction"])(tx, connectorAudit({
                action: 'connector.self_update.policy.update',
                actorId: input.actorId,
                tenantId: input.tenantId,
                connectorId: input.connectorId,
                policyDecision: 'allowed',
                metadata: input.policy
            }));
        }, {
            timeout: 60_000
        });
    }
    async listUsage(connectorId, tenantId) {
        // ponytail: playbook/process táblák nincsenek a core sémában — agent-kötés a hatáslista.
        const agentRows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentConnector.findMany({
            where: {
                connectorId,
                connector: {
                    tenantId
                },
                agent: {
                    status: 'active'
                }
            },
            select: {
                agent: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                agent: {
                    name: 'asc'
                }
            }
        });
        const usage = {};
        for (const row of agentRows)addUsage(usage, [
            '*'
        ], {
            type: 'agent',
            id: row.agent.id,
            name: row.agent.name
        });
        return usage;
    }
    async findOpenProposalByHash(connectorId, tenantId, rawHash) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorSpecVersion.findFirst({
            where: {
                connectorId,
                tenantId,
                rawHash,
                status: 'proposed'
            },
            orderBy: {
                versionNo: 'desc'
            }
        });
        return row ? versionOf(row) : null;
    }
    async createProposal(input) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const connector = await tx.connector.findFirst({
                where: {
                    id: input.connectorId,
                    tenantId: input.tenantId,
                    connectorMode: 'self_updating'
                },
                select: {
                    id: true
                }
            });
            if (!connector) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('NOT_FOUND', 'Az OpenAPI-kapcsolat nem található.');
            const latest = await tx.connectorSpecVersion.aggregate({
                where: {
                    connectorId: input.connectorId
                },
                _max: {
                    versionNo: true
                }
            });
            const proposal = await tx.connectorSpecVersion.create({
                data: {
                    connectorId: input.connectorId,
                    tenantId: input.tenantId,
                    versionNo: (latest._max.versionNo ?? 0) + 1,
                    rawSnapshot: input.rawSnapshot,
                    rawHash: input.rawHash,
                    capabilitySet: input.capabilitySet,
                    diffFromVersionId: input.diffFromVersionId,
                    diffSummary: input.diffSummary,
                    fetchedAt: input.fetchedAt,
                    status: 'proposed'
                }
            });
            await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["appendAuditInTransaction"])(tx, connectorAudit({
                action: 'connector.self_update.sync.proposed',
                actorId: input.actorId,
                tenantId: input.tenantId,
                connectorId: input.connectorId,
                policyDecision: 'human_approval_required',
                metadata: {
                    version_id: proposal.id,
                    version_no: proposal.versionNo,
                    diff: input.diffSummary
                }
            }));
            return proposal;
        }, {
            isolationLevel: __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].TransactionIsolationLevel.Serializable,
            timeout: 60_000
        });
        return versionOf(row);
    }
    async activateVersion(input) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const connector = await tx.connector.findFirst({
                where: {
                    id: input.connectorId,
                    tenantId: input.tenantId,
                    connectorMode: 'self_updating'
                },
                select: {
                    activeSpecVersionId: true
                }
            });
            const next = await tx.connectorSpecVersion.findFirst({
                where: {
                    id: input.versionId,
                    connectorId: input.connectorId,
                    tenantId: input.tenantId
                }
            });
            if (!connector || !next) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('NOT_FOUND', 'A verzió nem található.');
            if (next.status !== 'proposed') throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('INVALID_STATE', 'Csak javasolt verzió hagyható jóvá.');
            if (next.diffFromVersionId !== connector.activeSpecVersionId) {
                throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('INVALID_STATE', 'A javaslat már nem a jelenlegi verzióhoz készült. Keress újra frissítést.');
            }
            if (!input.approvedById) {
                const [source, tenant] = await Promise.all([
                    tx.connectorSpecSource.findFirst({
                        where: {
                            connectorId: input.connectorId,
                            tenantId: input.tenantId
                        },
                        select: {
                            autoApprovePolicy: true
                        }
                    }),
                    tx.tenant.findUnique({
                        where: {
                            id: input.tenantId
                        },
                        select: {
                            settings: true
                        }
                    })
                ]);
                if (!policyOf(source?.autoApprovePolicy)?.enabled || !(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$tenant$2d$settings$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["tenantSelfUpdateAutoApproveEnabled"])(tenant?.settings)) {
                    throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('INVALID_STATE', 'Az automatikus átvétel időközben ki lett kapcsolva; a javaslat emberi jóváhagyásra vár.');
                }
            }
            const rejectedProposals = await tx.connectorSpecVersion.findMany({
                where: {
                    connectorId: input.connectorId,
                    tenantId: input.tenantId,
                    status: 'proposed',
                    id: {
                        not: next.id
                    }
                },
                select: {
                    id: true
                }
            });
            await tx.connectorSpecVersion.updateMany({
                where: {
                    connectorId: input.connectorId,
                    tenantId: input.tenantId,
                    status: 'proposed',
                    id: {
                        not: next.id
                    }
                },
                data: {
                    status: 'rejected'
                }
            });
            if (connector.activeSpecVersionId) {
                await tx.connectorSpecVersion.update({
                    where: {
                        id: connector.activeSpecVersionId
                    },
                    data: {
                        status: 'superseded'
                    }
                });
            }
            const approved = await tx.connectorSpecVersion.update({
                where: {
                    id: next.id
                },
                data: {
                    status: 'approved',
                    approvedById: input.approvedById,
                    approvedAt: input.approvedAt
                }
            });
            const moved = await tx.connector.updateMany({
                where: {
                    id: input.connectorId,
                    tenantId: input.tenantId,
                    activeSpecVersionId: next.diffFromVersionId
                },
                data: {
                    activeSpecVersionId: approved.id
                }
            });
            if (moved.count !== 1) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('INVALID_STATE', 'A jelenlegi verzió időközben megváltozott. Keress újra frissítést.');
            await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["appendAuditInTransaction"])(tx, connectorAudit({
                action: input.approvedById ? 'connector.self_update.version.approve' : 'connector.self_update.version.auto_approve',
                actorId: input.approvedById,
                tenantId: input.tenantId,
                connectorId: input.connectorId,
                policyDecision: input.approvedById ? 'allowed' : 'auto_approved',
                metadata: {
                    version_id: approved.id,
                    version_no: approved.versionNo,
                    previous_version_id: connector.activeSpecVersionId,
                    triggered_by_id: input.actorId,
                    rejected_proposal_ids: rejectedProposals.map(({ id })=>id),
                    ...input.auditMetadata
                }
            }));
            return approved;
        }, {
            timeout: 60_000
        });
        return versionOf(row);
    }
    async rejectVersion(input) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const version = await tx.connectorSpecVersion.findFirst({
                where: {
                    id: input.versionId,
                    connectorId: input.connectorId,
                    tenantId: input.tenantId
                }
            });
            if (!version) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('NOT_FOUND', 'A verzió nem található.');
            if (version.status !== 'proposed') throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('INVALID_STATE', 'Csak javasolt verzió utasítható el.');
            const rejected = await tx.connectorSpecVersion.update({
                where: {
                    id: version.id
                },
                data: {
                    status: 'rejected'
                }
            });
            await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["appendAuditInTransaction"])(tx, connectorAudit({
                action: 'connector.self_update.version.reject',
                actorId: input.actorId,
                tenantId: input.tenantId,
                connectorId: input.connectorId,
                policyDecision: 'rejected',
                metadata: {
                    version_id: rejected.id,
                    version_no: rejected.versionNo
                }
            }));
            return rejected;
        }, {
            timeout: 60_000
        });
        return versionOf(row);
    }
    async rollback(input) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const connector = await tx.connector.findFirst({
                where: {
                    id: input.connectorId,
                    tenantId: input.tenantId,
                    connectorMode: 'self_updating'
                },
                select: {
                    activeSpecVersionId: true
                }
            });
            const target = await tx.connectorSpecVersion.findFirst({
                where: {
                    id: input.targetVersionId,
                    connectorId: input.connectorId,
                    tenantId: input.tenantId
                }
            });
            if (!connector || !target) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('NOT_FOUND', 'A korábbi verzió nem található.');
            if (![
                'approved',
                'superseded',
                'rolled_back'
            ].includes(target.status)) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('INVALID_STATE', 'Csak korábban jóváhagyott verzió állítható vissza.');
            const rejectedProposals = await tx.connectorSpecVersion.findMany({
                where: {
                    connectorId: input.connectorId,
                    tenantId: input.tenantId,
                    status: 'proposed'
                },
                select: {
                    id: true
                }
            });
            if (connector.activeSpecVersionId) await tx.connectorSpecVersion.update({
                where: {
                    id: connector.activeSpecVersionId
                },
                data: {
                    status: 'rolled_back'
                }
            });
            await tx.connectorSpecVersion.updateMany({
                where: {
                    connectorId: input.connectorId,
                    tenantId: input.tenantId,
                    status: 'proposed'
                },
                data: {
                    status: 'rejected'
                }
            });
            const restored = await tx.connectorSpecVersion.update({
                where: {
                    id: target.id
                },
                data: {
                    status: 'approved',
                    approvedById: input.actorId,
                    approvedAt: input.at
                }
            });
            const moved = await tx.connector.updateMany({
                where: {
                    id: input.connectorId,
                    tenantId: input.tenantId,
                    activeSpecVersionId: connector.activeSpecVersionId
                },
                data: {
                    activeSpecVersionId: restored.id
                }
            });
            if (moved.count !== 1) throw new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$domain$2f$connector$2d$self$2d$update$2f$self$2d$update$2d$service$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["SelfUpdateError"]('INVALID_STATE', 'A jelenlegi verzió időközben megváltozott.');
            await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["appendAuditInTransaction"])(tx, connectorAudit({
                action: 'connector.self_update.version.rollback',
                actorId: input.actorId,
                tenantId: input.tenantId,
                connectorId: input.connectorId,
                policyDecision: 'allowed',
                metadata: {
                    from_version_id: connector.activeSpecVersionId,
                    to_version_id: restored.id,
                    to_version_no: restored.versionNo,
                    rejected_proposal_ids: rejectedProposals.map(({ id })=>id)
                }
            }));
            return restored;
        }, {
            timeout: 60_000
        });
        return versionOf(row);
    }
    async listVersions(connectorId, tenantId) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorSpecVersion.findMany({
            where: {
                connectorId,
                tenantId
            },
            orderBy: {
                versionNo: 'desc'
            }
        });
        return rows.map(versionOf);
    }
    async touchSynced(sourceId, at) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].connectorSpecSource.update({
            where: {
                id: sourceId
            },
            data: {
                lastSyncedAt: at
            }
        });
    }
}
}),
"[project]/src/repositories/postgres/platform-settings-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresPlatformSettingsRepository",
    ()=>PostgresPlatformSettingsRepository
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
;
class PostgresPlatformSettingsRepository {
    async get(key) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].platformSetting.findUnique({
            where: {
                key
            }
        });
        return row ? row.value : null;
    }
    async set(key, value, updatedById) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].platformSetting.upsert({
            where: {
                key
            },
            create: {
                key,
                value,
                updatedById: updatedById ?? null
            },
            update: {
                value,
                updatedById: updatedById ?? null
            }
        });
    }
}
}),
"[project]/src/repositories/postgres/gateway-operation-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresGatewayOperationRepository",
    ()=>PostgresGatewayOperationRepository
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__ = __turbopack_context__.i("[externals]/@prisma/client [external] (@prisma/client, cjs, [project]/node_modules/@prisma/client)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
;
;
const INCLUDE = {
    approval: true,
    definition: {
        select: {
            agentId: true
        }
    }
};
function mapRow(row) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        agentDefinitionVersionId: row.agentDefinitionVersionId,
        agentId: row.definition.agentId,
        principalUserId: row.principalUserId,
        toolName: row.toolName,
        argsJson: row.argsJson,
        idempotencyKey: row.idempotencyKey,
        status: row.status,
        connectorId: row.connectorId,
        errorCode: row.errorCode,
        resultJson: row.resultJson,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        approval: row.approval ? {
            id: row.approval.id,
            decidedByUserId: row.approval.decidedByUserId,
            decision: row.approval.decision,
            reason: row.approval.reason,
            decidedAt: row.approval.decidedAt
        } : null
    };
}
function jsonValue(value) {
    return value;
}
class PostgresGatewayOperationRepository {
    async findById(id) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].gatewayOperation.findUnique({
            where: {
                id
            },
            include: INCLUDE
        });
        return row ? mapRow(row) : null;
    }
    async findByTenantAndIdempotencyKey(tenantId, idempotencyKey) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].gatewayOperation.findUnique({
            where: {
                tenantId_idempotencyKey: {
                    tenantId,
                    idempotencyKey
                }
            },
            include: INCLUDE
        });
        return row ? mapRow(row) : null;
    }
    async createAwaitingApproval(input) {
        try {
            const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].gatewayOperation.create({
                data: {
                    tenantId: input.tenantId,
                    agentDefinitionVersionId: input.agentDefinitionVersionId,
                    principalUserId: input.principalUserId,
                    toolName: input.toolName,
                    argsJson: jsonValue(input.argsJson),
                    idempotencyKey: input.idempotencyKey,
                    status: 'awaiting_approval',
                    connectorId: input.connectorId ?? null,
                    approval: {
                        create: {
                            decision: 'pending'
                        }
                    }
                },
                include: INCLUDE
            });
            return {
                record: mapRow(row),
                created: true
            };
        } catch (error) {
            if (error instanceof __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].PrismaClientKnownRequestError && error.code === 'P2002') {
                const existing = await this.findByTenantAndIdempotencyKey(input.tenantId, input.idempotencyKey);
                if (existing) return {
                    record: existing,
                    created: false
                };
            }
            throw error;
        }
    }
    async listAwaitingApproval(tenantId, principalUserId) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].gatewayOperation.findMany({
            where: {
                tenantId,
                status: 'awaiting_approval',
                ...principalUserId ? {
                    principalUserId
                } : {}
            },
            include: INCLUDE,
            orderBy: {
                createdAt: 'desc'
            }
        });
        return rows.map(mapRow);
    }
    async withLockedOperation(operationId, fn) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const locked = await tx.$queryRaw(__TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].sql`SELECT id FROM gateway_operations WHERE id = ${operationId}::uuid FOR UPDATE`);
            if (locked.length === 0) return null;
            const current = await tx.gatewayOperation.findUnique({
                where: {
                    id: operationId
                },
                include: INCLUDE
            });
            if (!current) return null;
            const save = async (patch)=>{
                return applyPatch(tx, operationId, patch);
            };
            return fn(mapRow(current), save);
        });
    }
    async update(id, patch) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction((tx)=>applyPatch(tx, id, patch));
    }
}
async function applyPatch(tx, id, patch) {
    if (patch.approval) {
        await tx.gatewayApproval.update({
            where: {
                operationId: id
            },
            data: {
                decision: patch.approval.decision,
                decidedByUserId: patch.approval.decidedByUserId,
                reason: patch.approval.reason ?? null,
                decidedAt: patch.approval.decidedAt
            }
        });
    }
    const row = await tx.gatewayOperation.update({
        where: {
            id
        },
        data: {
            ...patch.status ? {
                status: patch.status
            } : {},
            ...patch.errorCode !== undefined ? {
                errorCode: patch.errorCode
            } : {},
            ...patch.resultJson !== undefined ? {
                resultJson: patch.resultJson === null ? __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].JsonNull : jsonValue(patch.resultJson)
            } : {}
        },
        include: INCLUDE
    });
    return mapRow(row);
}
}),
"[project]/src/repositories/postgres/resource-grant-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresResourceGrantRepository",
    ()=>PostgresResourceGrantRepository
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
;
const VIEW_OR_OPERATE = [
    'view',
    'operate'
];
class PostgresResourceGrantRepository {
    async findAgentGrant(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].resourceGrant.findFirst({
            where: {
                tenantId: input.tenantId,
                userId: input.userId,
                resourceType: 'agent',
                resourceId: input.agentId,
                accessLevel: {
                    in: [
                        ...VIEW_OR_OPERATE
                    ]
                }
            }
        });
    }
    async listAgentGrantsForUser(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].resourceGrant.findMany({
            where: {
                tenantId: input.tenantId,
                userId: input.userId,
                resourceType: 'agent',
                accessLevel: {
                    in: [
                        ...VIEW_OR_OPERATE
                    ]
                }
            }
        });
    }
    async listAgentIdsGrantedToUser(input) {
        const rows = await this.listAgentGrantsForUser(input);
        return [
            ...new Set(rows.map((row)=>row.resourceId))
        ];
    }
    async listAgentGrantsForAgent(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].resourceGrant.findMany({
            where: {
                tenantId: input.tenantId,
                resourceType: 'agent',
                resourceId: input.agentId,
                accessLevel: {
                    in: [
                        ...VIEW_OR_OPERATE
                    ]
                }
            },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true
                    }
                }
            },
            orderBy: {
                grantedAt: 'desc'
            }
        });
    }
    async upsertAgentGrant(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].resourceGrant.upsert({
            where: {
                tenantId_userId_resourceType_resourceId: {
                    tenantId: input.tenantId,
                    userId: input.userId,
                    resourceType: 'agent',
                    resourceId: input.agentId
                }
            },
            create: {
                tenantId: input.tenantId,
                userId: input.userId,
                resourceType: 'agent',
                resourceId: input.agentId,
                accessLevel: input.accessLevel,
                grantedById: input.grantedById
            },
            update: {
                accessLevel: input.accessLevel,
                grantedById: input.grantedById
            }
        });
    }
    async revokeAgentGrant(input) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].resourceGrant.deleteMany({
            where: {
                tenantId: input.tenantId,
                userId: input.userId,
                resourceType: 'agent',
                resourceId: input.agentId
            }
        });
    }
}
}),
"[project]/src/lib/skill/skill-agent-migration.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "dedupeAgentSkillAssignments",
    ()=>dedupeAgentSkillAssignments,
    "mergedEnabledForAgent",
    ()=>mergedEnabledForAgent,
    "planAgentSkillMigrations",
    ()=>planAgentSkillMigrations
]);
function planAgentSkillMigrations(assignments, activeVersionId) {
    const stale = assignments.filter((a)=>a.skillVersionId !== activeVersionId);
    if (stale.length === 0) return [];
    const byAgent = new Map();
    for (const row of stale){
        const cur = byAgent.get(row.agentId) ?? {
            enabled: false,
            fromVersionIds: []
        };
        cur.enabled = cur.enabled || row.enabled;
        cur.fromVersionIds.push(row.skillVersionId);
        byAgent.set(row.agentId, cur);
    }
    const migrations = [];
    for (const [agentId, { enabled, fromVersionIds }] of byAgent){
        for (const fromVersionId of fromVersionIds){
            migrations.push({
                agentId,
                fromVersionId,
                toVersionId: activeVersionId,
                enabled
            });
        }
    }
    return migrations;
}
function mergedEnabledForAgent(existingEnabled, migratedEnabled) {
    return (existingEnabled ?? false) || migratedEnabled;
}
function dedupeAgentSkillAssignments(assignments) {
    const bySkillId = new Map();
    for (const row of assignments){
        const skillId = row.skillVersion.skill.id;
        const existing = bySkillId.get(skillId);
        if (!existing || row.skillVersion.version > existing.skillVersion.version) {
            bySkillId.set(skillId, row);
        }
    }
    return [
        ...bySkillId.values()
    ];
}
}),
"[project]/src/repositories/postgres/skill-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresSkillRepository",
    ()=>PostgresSkillRepository
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$skill$2f$skill$2d$agent$2d$migration$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/skill/skill-agent-migration.ts [app-rsc] (ecmascript)");
;
;
async function migrateAgentAssignmentsToVersion(tx, skillId, activeVersionId, assignedById) {
    const stale = await tx.agentSkill.findMany({
        where: {
            skillVersion: {
                skillId
            },
            NOT: {
                skillVersionId: activeVersionId
            }
        },
        select: {
            agentId: true,
            skillVersionId: true,
            enabled: true,
            entry: true
        }
    });
    const plan = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$skill$2f$skill$2d$agent$2d$migration$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["planAgentSkillMigrations"])(stale, activeVersionId);
    if (plan.length === 0) return [];
    const byAgent = new Map();
    for (const row of stale){
        const cur = byAgent.get(row.agentId) ?? {
            enabled: false,
            entry: false,
            fromVersionIds: []
        };
        cur.enabled = cur.enabled || row.enabled;
        cur.entry = cur.entry || row.entry;
        cur.fromVersionIds.push(row.skillVersionId);
        byAgent.set(row.agentId, cur);
    }
    const migrations = [];
    for (const [agentId, { enabled, entry, fromVersionIds }] of byAgent){
        const existing = await tx.agentSkill.findUnique({
            where: {
                agentId_skillVersionId: {
                    agentId,
                    skillVersionId: activeVersionId
                }
            },
            select: {
                enabled: true,
                entry: true
            }
        });
        const finalEnabled = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$skill$2f$skill$2d$agent$2d$migration$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["mergedEnabledForAgent"])(existing?.enabled, enabled);
        const finalEntry = Boolean(existing?.entry) || entry;
        // Delete before upsert: the one-entry-per-agent index would reject a second entry row.
        await tx.agentSkill.deleteMany({
            where: {
                agentId,
                skillVersionId: {
                    in: fromVersionIds
                }
            }
        });
        await tx.agentSkill.upsert({
            where: {
                agentId_skillVersionId: {
                    agentId,
                    skillVersionId: activeVersionId
                }
            },
            create: {
                agentId,
                skillVersionId: activeVersionId,
                enabled: finalEnabled,
                entry: finalEntry,
                assignedById
            },
            update: {
                enabled: finalEnabled,
                entry: finalEntry,
                assignedById
            }
        });
        for (const fromVersionId of fromVersionIds){
            migrations.push({
                agentId,
                fromVersionId,
                toVersionId: activeVersionId,
                enabled: finalEnabled
            });
        }
    }
    return migrations;
}
class PostgresSkillRepository {
    async listForTenant(actorTenantId) {
        // Global (tenantId null) MINDIG, a tenant-lokálisak KIZÁRÓLAG a saját tenanté
        // (fail-closed — idegen tenant skillje sosem kerül a listába).
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skill.findMany({
            where: {
                OR: [
                    {
                        tenantId: null
                    },
                    ...actorTenantId ? [
                        {
                            tenantId: actorTenantId
                        }
                    ] : []
                ]
            },
            orderBy: {
                createdAt: 'desc'
            },
            include: {
                versions: {
                    orderBy: {
                        version: 'desc'
                    }
                }
            }
        });
    }
    async findById(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skill.findUnique({
            where: {
                id
            },
            include: {
                versions: {
                    orderBy: {
                        version: 'desc'
                    }
                }
            }
        });
    }
    async findByNameInScope(name, tenantId) {
        const normalized = name.trim().toLowerCase();
        if (!normalized) return null;
        // DB-oldali case-insensitive egyezés — ne töltsük be a tenant összes skilljét JS-be.
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skill.findFirst({
            where: {
                tenantId,
                name: {
                    equals: normalized,
                    mode: 'insensitive'
                }
            }
        });
    }
    async findVersionById(versionId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skillVersion.findUnique({
            where: {
                id: versionId
            },
            include: {
                skill: true
            }
        });
    }
    async findVersionsByIds(versionIds) {
        if (versionIds.length === 0) return [];
        const unique = [
            ...new Set(versionIds)
        ];
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skillVersion.findMany({
            where: {
                id: {
                    in: unique
                }
            },
            include: {
                skill: true
            }
        });
    }
    async createSkill(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const skill = await tx.skill.create({
                data: {
                    name: input.name,
                    displayName: input.displayName ?? null,
                    description: input.description,
                    catalogScope: input.catalogScope,
                    tenantId: input.tenantId,
                    kind: input.kind,
                    sourceType: input.sourceType,
                    provenance: input.provenance ?? undefined,
                    license: input.license,
                    riskTier: input.riskTier,
                    producesSkills: input.producesSkills ?? false
                }
            });
            const version = await tx.skillVersion.create({
                data: {
                    skillId: skill.id,
                    version: 1,
                    content: input.content,
                    requires: input.requires,
                    ...input.attachments !== undefined ? {
                        attachments: input.attachments
                    } : {},
                    contentHash: input.contentHash,
                    status: 'proposed'
                }
            });
            return {
                skill,
                version
            };
        });
    }
    async updateDisplayName(skillId, displayName) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skill.update({
            where: {
                id: skillId
            },
            data: {
                displayName
            }
        });
    }
    async updateKind(skillId, kind) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skill.update({
            where: {
                id: skillId
            },
            data: {
                kind
            }
        });
    }
    async updateDescription(skillId, description) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skill.update({
            where: {
                id: skillId
            },
            data: {
                description
            }
        });
    }
    async addVersion(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const latest = await tx.skillVersion.findFirst({
                where: {
                    skillId: input.skillId
                },
                orderBy: {
                    version: 'desc'
                },
                select: {
                    version: true
                }
            });
            return tx.skillVersion.create({
                data: {
                    skillId: input.skillId,
                    version: (latest?.version ?? 0) + 1,
                    content: input.content,
                    requires: input.requires,
                    ...input.attachments !== undefined ? {
                        attachments: input.attachments
                    } : {},
                    contentHash: input.contentHash,
                    status: 'proposed'
                }
            });
        });
    }
    async approveVersion(versionId, params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const target = await tx.skillVersion.findUnique({
                where: {
                    id: versionId
                }
            });
            if (!target) throw new Error('Skill version not found');
            await tx.skillVersion.updateMany({
                where: {
                    skillId: target.skillId,
                    status: 'active'
                },
                data: {
                    status: 'retired'
                }
            });
            const version = await tx.skillVersion.update({
                where: {
                    id: versionId
                },
                data: {
                    status: 'active',
                    approvedById: params.approverId
                }
            });
            const agentMigrations = await migrateAgentAssignmentsToVersion(tx, target.skillId, versionId, params.approverId);
            return {
                version,
                agentMigrations
            };
        });
    }
    async rollbackToVersion(versionId, params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const target = await tx.skillVersion.findUnique({
                where: {
                    id: versionId
                }
            });
            if (!target) throw new Error('Skill version not found');
            // Az aktuálisan aktív verziót rolled_back-re állítjuk (megkülönböztethető a
            // sima retire-tól), a cél-verziót újraaktiváljuk.
            await tx.skillVersion.updateMany({
                where: {
                    skillId: target.skillId,
                    status: 'active'
                },
                data: {
                    status: 'rolled_back'
                }
            });
            const version = await tx.skillVersion.update({
                where: {
                    id: versionId
                },
                data: {
                    status: 'active',
                    approvedById: params.approverId
                }
            });
            const agentMigrations = await migrateAgentAssignmentsToVersion(tx, target.skillId, versionId, params.approverId);
            return {
                version,
                agentMigrations
            };
        });
    }
    async getActiveVersion(skillId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skillVersion.findFirst({
            where: {
                skillId,
                status: 'active'
            },
            orderBy: {
                version: 'desc'
            }
        });
    }
    async retireActiveVersion(skillId) {
        const active = await this.getActiveVersion(skillId);
        if (!active) return null;
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skillVersion.update({
            where: {
                id: active.id
            },
            data: {
                status: 'retired'
            }
        });
    }
    async countAssignmentsForSkill(skillId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentSkill.count({
            where: {
                skillVersion: {
                    skillId
                }
            }
        });
    }
    async detachAllAssignmentsForSkill(skillId) {
        const result = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentSkill.deleteMany({
            where: {
                skillVersion: {
                    skillId
                }
            }
        });
        return result.count;
    }
    async deleteSkill(skillId) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].skill.delete({
            where: {
                id: skillId
            }
        });
    }
    async listAgentSkillRows(agentId, enabledOnly) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentSkill.findMany({
            where: {
                agentId,
                ...enabledOnly ? {
                    enabled: true
                } : {}
            },
            orderBy: {
                createdAt: enabledOnly ? 'asc' : 'desc'
            },
            include: {
                skillVersion: {
                    include: {
                        skill: true
                    }
                }
            }
        });
        const deduped = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$skill$2f$skill$2d$agent$2d$migration$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["dedupeAgentSkillAssignments"])(rows);
        if (deduped.length < rows.length) {
            const keptIds = new Set(deduped.map((row)=>row.skillVersionId));
            const pruneIds = rows.filter((row)=>!keptIds.has(row.skillVersionId)).map((row)=>row.skillVersionId);
            await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentSkill.deleteMany({
                where: {
                    agentId,
                    skillVersionId: {
                        in: pruneIds
                    }
                }
            });
        }
        return deduped;
    }
    async assign(input) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            const target = await tx.skillVersion.findUnique({
                where: {
                    id: input.skillVersionId
                },
                select: {
                    skillId: true
                }
            });
            if (!target) throw new Error('Skill version not found');
            const stale = await tx.agentSkill.findMany({
                where: {
                    agentId: input.agentId,
                    skillVersion: {
                        skillId: target.skillId
                    },
                    NOT: {
                        skillVersionId: input.skillVersionId
                    }
                },
                select: {
                    skillVersionId: true,
                    entry: true
                }
            });
            const replacedVersionIds = stale.map((row)=>row.skillVersionId);
            const entry = stale.some((row)=>row.entry);
            if (replacedVersionIds.length > 0) {
                await tx.agentSkill.deleteMany({
                    where: {
                        agentId: input.agentId,
                        skillVersionId: {
                            in: replacedVersionIds
                        }
                    }
                });
            }
            const assignment = await tx.agentSkill.upsert({
                where: {
                    agentId_skillVersionId: {
                        agentId: input.agentId,
                        skillVersionId: input.skillVersionId
                    }
                },
                create: {
                    agentId: input.agentId,
                    skillVersionId: input.skillVersionId,
                    assignedById: input.assignedById,
                    enabled: true,
                    entry
                },
                update: {
                    enabled: true,
                    assignedById: input.assignedById,
                    ...entry ? {
                        entry
                    } : {}
                }
            });
            return {
                assignment,
                replacedVersionIds
            };
        });
    }
    async unassign(agentId, skillVersionId) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentSkill.deleteMany({
            where: {
                agentId,
                skillVersionId
            }
        });
    }
    async setEnabled(agentId, skillVersionId, enabled) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentSkill.update({
            where: {
                agentId_skillVersionId: {
                    agentId,
                    skillVersionId
                }
            },
            data: {
                enabled
            }
        });
    }
    async setEntry(agentId, skillVersionId, entry) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            if (entry) {
                await tx.agentSkill.updateMany({
                    where: {
                        agentId,
                        entry: true
                    },
                    data: {
                        entry: false
                    }
                });
            }
            await tx.agentSkill.update({
                where: {
                    agentId_skillVersionId: {
                        agentId,
                        skillVersionId
                    }
                },
                data: {
                    entry
                }
            });
        });
    }
    async listAgentSkills(agentId) {
        return this.listAgentSkillRows(agentId, false);
    }
    async listEnabledForAgent(agentId) {
        return this.listAgentSkillRows(agentId, true);
    }
    async findAssignment(agentId, skillVersionId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agentSkill.findUnique({
            where: {
                agentId_skillVersionId: {
                    agentId,
                    skillVersionId
                }
            },
            include: {
                skillVersion: {
                    include: {
                        skill: true
                    }
                }
            }
        });
    }
}
}),
"[project]/src/repositories/postgres/iam-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "DEFAULT_ROLE_PERMISSIONS",
    ()=>DEFAULT_ROLE_PERMISSIONS,
    "PostgresInvitationRepository",
    ()=>PostgresInvitationRepository,
    "PostgresRolePermissionRepository",
    ()=>PostgresRolePermissionRepository,
    "PostgresUserRepository",
    ()=>PostgresUserRepository,
    "ensureDefaultRolePermissions",
    ()=>ensureDefaultRolePermissions
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$list$2d$pagination$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/list-pagination.ts [app-rsc] (ecmascript)");
;
;
class PostgresUserRepository {
    async findById(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.findUnique({
            where: {
                id
            }
        });
    }
    async findByExternalAuthId(externalAuthId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.findUnique({
            where: {
                externalAuthId
            }
        });
    }
    async findManyByEmail(email) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.findMany({
            where: {
                email: {
                    equals: email,
                    mode: 'insensitive'
                }
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
    }
    async findMany(filter) {
        const { take, skip, pageLimit } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$list$2d$pagination$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prismaPageArgs"])(filter?.unbounded || filter?.limit === undefined && filter?.offset === undefined ? {
            unbounded: true
        } : filter);
        const offset = skip ?? 0;
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.findMany({
            where: {
                ...filter?.status ? {
                    status: filter.status
                } : {},
                ...filter?.role ? {
                    role: filter.role
                } : {}
            },
            orderBy: {
                createdAt: 'asc'
            },
            ...take !== undefined ? {
                take,
                skip: offset
            } : {}
        });
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$list$2d$pagination$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["toListPage"])(rows, pageLimit, offset).items;
    }
    async findManyByIds(ids) {
        if (ids.length === 0) return [];
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.findMany({
            where: {
                id: {
                    in: ids
                }
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
    }
    async countActiveAdmins(tenantId, excludeUserId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.count({
            where: {
                tenantId,
                role: 'admin',
                status: 'active',
                ...excludeUserId ? {
                    userId: {
                        not: excludeUserId
                    }
                } : {}
            }
        });
    }
    async create(data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.create({
            data: {
                externalAuthId: data.externalAuthId,
                email: data.email,
                name: data.name,
                role: data.role ?? null,
                status: data.status ?? 'pending',
                invitedById: data.invitedById ?? null
            }
        });
    }
    async update(id, data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.update({
            where: {
                id
            },
            data
        });
    }
    async upsertByExternalAuthId(params) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.upsert({
            where: {
                externalAuthId: params.externalAuthId
            },
            create: {
                externalAuthId: params.externalAuthId,
                email: params.create.email,
                name: params.create.name,
                role: params.create.role ?? null,
                status: params.create.status ?? 'pending'
            },
            update: params.update
        });
    }
}
class PostgresInvitationRepository {
    async findById(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].invitation.findUnique({
            where: {
                id
            }
        });
    }
    async findByTokenHash(tokenHash) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].invitation.findUnique({
            where: {
                tokenHash
            }
        });
    }
    async findMany(filter) {
        const { take, skip, pageLimit } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$list$2d$pagination$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prismaPageArgs"])(filter?.unbounded || filter?.limit === undefined && filter?.offset === undefined ? {
            unbounded: true
        } : filter);
        const offset = skip ?? 0;
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].invitation.findMany({
            where: {
                ...filter?.status ? {
                    status: filter.status
                } : {}
            },
            orderBy: {
                createdAt: 'desc'
            },
            ...take !== undefined ? {
                take,
                skip: offset
            } : {}
        });
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$list$2d$pagination$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["toListPage"])(rows, pageLimit, offset).items;
    }
    async claimPendingRedemption(id, email, now) {
        const claimed = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].invitation.updateMany({
            where: {
                id,
                email: email.trim().toLowerCase(),
                status: 'pending',
                expiresAt: {
                    gt: now
                }
            },
            data: {
                status: 'redeemed',
                redeemedAt: now
            }
        });
        if (claimed.count !== 1) return null;
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].invitation.findUnique({
            where: {
                id
            }
        });
    }
    async revokePending(id, revokedAt) {
        const revoked = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].invitation.updateMany({
            where: {
                id,
                status: 'pending'
            },
            data: {
                status: 'revoked',
                revokedAt
            }
        });
        if (revoked.count !== 1) return null;
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].invitation.findUnique({
            where: {
                id
            }
        });
    }
    async create(data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].invitation.create({
            data: {
                tenantId: data.tenantId,
                email: data.email,
                role: data.role,
                tokenHash: data.tokenHash,
                expiresAt: data.expiresAt,
                createdById: data.createdById
            }
        });
    }
    async update(id, data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].invitation.update({
            where: {
                id
            },
            data
        });
    }
}
class PostgresRolePermissionRepository {
    async findAll() {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].rolePermission.findMany({
            orderBy: {
                permissionKey: 'asc'
            }
        });
    }
    async findByKey(permissionKey) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].rolePermission.findUnique({
            where: {
                permissionKey
            }
        });
    }
    async findByKeys(permissionKeys) {
        if (permissionKeys.length === 0) return [];
        const unique = [
            ...new Set(permissionKeys)
        ];
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].rolePermission.findMany({
            where: {
                permissionKey: {
                    in: unique
                }
            }
        });
    }
    async upsert(permissionKey, minRole, description) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].rolePermission.upsert({
            where: {
                permissionKey
            },
            create: {
                permissionKey,
                minRole,
                description: description ?? null
            },
            update: {
                minRole,
                ...description !== undefined ? {
                    description
                } : {}
            }
        });
    }
}
const DEFAULT_ROLE_PERMISSIONS = [
    {
        permissionKey: 'user.invite',
        minRole: 'admin',
        description: 'Meghívó kiállítása'
    },
    {
        permissionKey: 'user.invite.revoke',
        minRole: 'admin',
        description: 'Meghívó visszavonása'
    },
    {
        permissionKey: 'user.approve',
        minRole: 'admin',
        description: 'Pending önregisztráció jóváhagyása'
    },
    {
        permissionKey: 'user.role.write',
        minRole: 'admin',
        description: 'Szerepkör módosítása'
    },
    {
        permissionKey: 'user.suspend',
        minRole: 'admin',
        description: 'Felfüggesztés / visszaállítás'
    },
    {
        permissionKey: 'user.read',
        minRole: 'admin',
        description: 'Felhasználólista olvasása'
    },
    {
        permissionKey: 'audit.read',
        minRole: 'approver',
        description: 'Hozzáférési audit olvasása'
    },
    {
        permissionKey: 'user.permission.write',
        minRole: 'admin',
        description: 'Permission-mátrix szerkesztése'
    },
    // agent-memory-persistent-cross-conversation-spec.md §12.1 (WP-1/WP-6)
    {
        permissionKey: 'memory.propose',
        minRole: 'operator',
        description: 'Memória-javaslat kezdeményezése'
    },
    {
        permissionKey: 'memory.inline_approve',
        minRole: 'approver',
        description: 'Memória-javaslat azonnali jóváhagyása (write-gate)'
    },
    {
        permissionKey: 'memory.ticket_approve',
        minRole: 'approver',
        description: 'Memória-javaslat jóváhagyása tanítási ticketen át'
    },
    {
        permissionKey: 'memory.maintenance.run',
        minRole: 'admin',
        description: 'Memória-karbantartás (consolidation) indítása'
    },
    {
        permissionKey: 'memory.rollback',
        minRole: 'admin',
        description: 'Memória-verzió visszagörgetése'
    },
    {
        permissionKey: 'memory.delete_approve',
        minRole: 'admin',
        description: 'Memóriaelem végleges (hard) törlésének jóváhagyása'
    },
    {
        permissionKey: 'analysis.run',
        minRole: 'admin',
        description: 'Futás-elemző agent elérése és elemzés indítása'
    }
];
async function ensureDefaultRolePermissions(repo = new PostgresRolePermissionRepository()) {
    for (const entry of DEFAULT_ROLE_PERMISSIONS){
        const existing = await repo.findByKey(entry.permissionKey);
        if (!existing) {
            await repo.upsert(entry.permissionKey, entry.minRole, entry.description);
        }
    }
}
}),
"[project]/src/repositories/order-by-ids.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * A batch `IN (...)` lekérdezések eredménye nem garantálja a bemeneti ID-k
 * sorrendjét. Ez a helper visszaállítja az eredeti findById/Promise.all
 * szemantikát: a kért sorrendet és duplikációkat megtartja, a hiányzó ID-ket
 * pedig kihagyja.
 */ __turbopack_context__.s([
    "orderRowsByIds",
    ()=>orderRowsByIds
]);
function orderRowsByIds(ids, rows) {
    const rowsById = new Map(rows.map((row)=>[
            row.id,
            row
        ]));
    const ordered = [];
    for (const id of ids){
        const row = rowsById.get(id);
        if (row) ordered.push(row);
    }
    return ordered;
}
}),
"[project]/src/repositories/postgres/tenant-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresPlatformMembershipRepository",
    ()=>PostgresPlatformMembershipRepository,
    "PostgresTenantMembershipRepository",
    ()=>PostgresTenantMembershipRepository,
    "PostgresTenantRepository",
    ()=>PostgresTenantRepository
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$order$2d$by$2d$ids$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/order-by-ids.ts [app-rsc] (ecmascript)");
;
;
class PostgresTenantRepository {
    async findById(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenant.findUnique({
            where: {
                id
            }
        });
    }
    async findByIds(ids) {
        if (ids.length === 0) return [];
        const unique = [
            ...new Set(ids)
        ];
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenant.findMany({
            where: {
                id: {
                    in: unique
                }
            }
        });
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$order$2d$by$2d$ids$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["orderRowsByIds"])(ids, rows);
    }
    async findBySlug(slug) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenant.findUnique({
            where: {
                slug
            }
        });
    }
    async findMany(filter) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenant.findMany({
            where: {
                ...filter?.status ? {
                    status: filter.status
                } : {}
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
    }
    async create(data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenant.create({
            data: {
                slug: data.slug,
                displayName: data.displayName,
                legalName: data.legalName ?? null,
                domainAllowlist: data.domainAllowlist ?? [],
                ...data.settings !== undefined ? {
                    settings: data.settings
                } : {},
                createdById: data.createdById ?? null
            }
        });
    }
    async update(id, data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenant.update({
            where: {
                id
            },
            data: {
                ...data.displayName !== undefined ? {
                    displayName: data.displayName
                } : {},
                ...data.legalName !== undefined ? {
                    legalName: data.legalName
                } : {},
                ...data.status !== undefined ? {
                    status: data.status
                } : {},
                ...data.domainAllowlist !== undefined ? {
                    domainAllowlist: data.domainAllowlist
                } : {},
                ...data.settings !== undefined ? {
                    settings: data.settings
                } : {}
            }
        });
    }
}
class PostgresTenantMembershipRepository {
    async findById(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.findUnique({
            where: {
                id
            }
        });
    }
    async findByTenantAndUser(tenantId, userId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.findUnique({
            where: {
                tenantId_userId: {
                    tenantId,
                    userId
                }
            }
        });
    }
    async findByUser(userId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.findMany({
            where: {
                userId
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
    }
    async findByTenant(tenantId, filter) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.findMany({
            where: {
                tenantId,
                ...filter?.status ? {
                    status: filter.status
                } : {},
                ...filter?.role ? {
                    role: filter.role
                } : {}
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
    }
    async findByTenantWithUsers(tenantId) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.findMany({
            where: {
                tenantId
            },
            include: {
                user: {
                    select: {
                        email: true,
                        name: true
                    }
                }
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
        return rows.map(({ user, ...m })=>({
                ...m,
                userEmail: user.email,
                userName: user.name
            }));
    }
    async countActiveAdmins(tenantId, excludeUserId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.count({
            where: {
                tenantId,
                role: 'admin',
                status: 'active',
                ...excludeUserId ? {
                    userId: {
                        not: excludeUserId
                    }
                } : {}
            }
        });
    }
    async create(data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.create({
            data: {
                tenantId: data.tenantId,
                userId: data.userId,
                role: data.role,
                status: data.status ?? 'pending',
                isDefault: data.isDefault ?? false,
                invitedById: data.invitedById ?? null,
                ...data.status === 'active' ? {
                    activatedAt: new Date()
                } : {}
            }
        });
    }
    async upsert(data) {
        const status = data.status ?? 'pending';
        const activatedAt = status === 'active' ? new Date() : null;
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.upsert({
            where: {
                tenantId_userId: {
                    tenantId: data.tenantId,
                    userId: data.userId
                }
            },
            create: {
                tenantId: data.tenantId,
                userId: data.userId,
                role: data.role,
                status,
                isDefault: data.isDefault ?? false,
                invitedById: data.invitedById ?? null,
                ...activatedAt ? {
                    activatedAt
                } : {}
            },
            update: {
                role: data.role,
                status,
                ...data.isDefault !== undefined ? {
                    isDefault: data.isDefault
                } : {},
                ...activatedAt ? {
                    activatedAt
                } : {}
            }
        });
    }
    async update(id, data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].tenantMembership.update({
            where: {
                id
            },
            data
        });
    }
}
class PostgresPlatformMembershipRepository {
    async findByUser(userId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].platformMembership.findMany({
            where: {
                userId
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
    }
    async findByRole(role, filter) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].platformMembership.findMany({
            where: {
                role,
                ...filter?.status ? {
                    status: filter.status
                } : {}
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
    }
    async findAll() {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].platformMembership.findMany({
            include: {
                user: {
                    select: {
                        email: true,
                        name: true
                    }
                }
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
        return rows.map(({ user, ...m })=>({
                ...m,
                userEmail: user.email,
                userName: user.name
            }));
    }
    async upsert(data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].platformMembership.upsert({
            where: {
                userId_role: {
                    userId: data.userId,
                    role: data.role
                }
            },
            create: {
                userId: data.userId,
                role: data.role,
                status: data.status ?? 'active'
            },
            update: {
                ...data.status ? {
                    status: data.status
                } : {}
            }
        });
    }
    async delete(userId, role) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].platformMembership.deleteMany({
            where: {
                userId,
                role
            }
        });
    }
}
}),
"[project]/src/lib/kb-retrieval.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "KB_DOCUMENT_INLINE_CHARS",
    ()=>KB_DOCUMENT_INLINE_CHARS,
    "KB_SECTION_PATH_SEPARATOR",
    ()=>KB_SECTION_PATH_SEPARATOR,
    "KB_SECTION_SPLIT_SQL",
    ()=>KB_SECTION_SPLIT_SQL,
    "assembleKbCatalog",
    ()=>assembleKbCatalog,
    "assembleKbDocument",
    ()=>assembleKbDocument,
    "assembleKbHits",
    ()=>assembleKbHits,
    "assembleKbIndex",
    ()=>assembleKbIndex,
    "assembleKbPage",
    ()=>assembleKbPage,
    "kbSectionForSegment",
    ()=>kbSectionForSegment,
    "normalizeKbPurpose",
    ()=>normalizeKbPurpose,
    "normalizeText",
    ()=>normalizeText,
    "okfIndexFile",
    ()=>okfIndexFile,
    "rankKbHits",
    ()=>rankKbHits,
    "readKbPurpose",
    ()=>readKbPurpose,
    "snippet",
    ()=>snippet,
    "splitKbSegments",
    ()=>splitKbSegments
]);
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function snippet(value) {
    return value.length > 2000 ? `${value.slice(0, 1997)}...` : value;
}
function normalizeText(value) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ');
}
const STEM_LENGTH = 4;
function stemToken(token) {
    return token.length <= STEM_LENGTH ? token : token.slice(0, STEM_LENGTH);
}
function queryTermStems(query) {
    return [
        ...new Set(normalizeText(query).split(/\s+/).map((term)=>term.trim()).filter((term)=>term.length >= 3).map(stemToken))
    ];
}
function stemsFromText(text) {
    return [
        ...new Set(normalizeText(text).split(/\s+/).filter(Boolean).filter((term)=>term.length >= 3).map(stemToken))
    ];
}
function filenameSearchText(filename) {
    return filename.replace(/[._-]+/g, ' ');
}
function documentSearchCorpus(filename, extractedText) {
    const header = filenameSearchText(filename);
    const body = extractedText?.trim() ?? '';
    return body ? `${header}\n\n${body}` : header;
}
function toKbSource(sourceRef, section) {
    const ref = isRecord(sourceRef) ? sourceRef : {};
    return {
        documentId: typeof ref.documentId === 'string' ? ref.documentId : undefined,
        filename: typeof ref.filename === 'string' ? ref.filename : undefined,
        page: typeof ref.page === 'number' ? ref.page : undefined,
        section: section ?? (typeof ref.section === 'string' ? ref.section : undefined),
        cell: typeof ref.cell === 'string' ? ref.cell : undefined
    };
}
function pathDepth(path) {
    return path.split('/').filter(Boolean).length;
}
function assembleKbHits(input) {
    const { query, k } = input;
    const termStems = queryTermStems(query);
    const FILENAME_STEM_WEIGHT = 3;
    function scoreChunks(text, docId, sourceRef, memoryVersion, filenameStems = []) {
        const filenameStemSet = new Set(filenameStems);
        return text.split(/\n{2,}|\n(?=-\s+)/).map((chunk)=>chunk.trim()).filter(Boolean).map((chunk)=>{
            const chunkStems = new Set(normalizeText(chunk).split(/\s+/).filter(Boolean).map(stemToken));
            const score = termStems.reduce((sum, stem)=>{
                if (filenameStemSet.has(stem)) return sum + FILENAME_STEM_WEIGHT;
                if (chunkStems.has(stem)) return sum + 1;
                return sum;
            }, 0);
            return {
                chunk,
                score,
                docId,
                sourceRef,
                memoryVersion
            };
        }).filter((item)=>item.score > 0);
    }
    const okfHits = input.okfChunkHits.map((hit)=>{
        const ref = isRecord(hit.sourceRef) ? hit.sourceRef : {};
        const source = {
            documentId: typeof ref.documentId === 'string' ? ref.documentId : undefined,
            filename: typeof ref.filename === 'string' ? ref.filename : undefined,
            page: typeof ref.page === 'number' ? ref.page : undefined,
            section: hit.section ?? (typeof ref.section === 'string' ? ref.section : undefined),
            cell: typeof ref.cell === 'string' ? ref.cell : undefined
        };
        return {
            docId: source.documentId ? `doc:${source.documentId}` : `okf:${hit.artifactId}`,
            snippet: snippet(hit.text),
            sourceRef: `okf:${hit.path}:${source.filename ?? hit.title}`,
            memoryVersion: null,
            path: hit.path,
            title: hit.title,
            score: hit.score,
            source
        };
    });
    const memoryChunks = scoreChunks(input.memoryContent, `memory:${input.memoryId}`, `memory:${input.memoryId}:v${input.memoryVersion ?? 'unknown'}`, input.memoryVersion);
    const flatDocs = input.docs.filter((doc)=>!input.supersededDocIds.has(doc.id));
    const docChunks = flatDocs.flatMap((doc)=>scoreChunks(documentSearchCorpus(doc.filename, doc.extractedText), `doc:${doc.id}`, `doc:${doc.id}:${doc.filename}`, null, stemsFromText(filenameSearchText(doc.filename))));
    const legacyHits = [
        ...memoryChunks,
        ...docChunks
    ].sort((a, b)=>b.score - a.score).map((item)=>({
            docId: item.docId,
            snippet: snippet(item.chunk),
            sourceRef: item.sourceRef,
            memoryVersion: item.memoryVersion
        }));
    const hits = [
        ...okfHits,
        ...legacyHits
    ].slice(0, k);
    if (hits.length > 0) return hits;
    if (flatDocs.length === 0) return hits;
    return flatDocs.map((doc)=>{
        const corpus = normalizeText(documentSearchCorpus(doc.filename, doc.extractedText));
        const filenameScore = stemsFromText(filenameSearchText(doc.filename)).filter((stem)=>termStems.includes(stem)).length;
        const contentScore = termStems.filter((stem)=>corpus.includes(stem)).length;
        return {
            doc,
            score: Math.max(filenameScore, contentScore)
        };
    }).filter((item)=>item.score > 0).sort((a, b)=>b.score - a.score).slice(0, k).map(({ doc })=>({
            docId: `doc:${doc.id}`,
            snippet: snippet(documentSearchCorpus(doc.filename, doc.extractedText)),
            sourceRef: `doc:${doc.id}:${doc.filename}`,
            memoryVersion: null
        }));
}
function assembleKbIndex(entries, maxDepth) {
    const pages = entries.filter((entry)=>maxDepth === undefined || pathDepth(entry.path) <= maxDepth).map((entry)=>({
            path: entry.path,
            title: entry.title,
            type: entry.type,
            artifactId: entry.artifactId
        }));
    return {
        pages
    };
}
function assembleKbPage(path, chunks) {
    if (chunks.length === 0) return {
        found: false,
        path
    };
    const ordered = [
        ...chunks
    ].sort((a, b)=>a.chunkIndex - b.chunkIndex);
    const first = ordered[0];
    return {
        found: true,
        path,
        title: first.title,
        type: first.type,
        artifactId: first.artifactId,
        text: ordered.map((chunk)=>chunk.text.trim()).filter(Boolean).join('\n\n'),
        source: toKbSource(first.sourceRef, first.section)
    };
}
function rankKbHits(candidates, k) {
    const df = new Map();
    for (const c of candidates){
        for (const term of new Set(c.matched))df.set(term, (df.get(term) ?? 0) + 1);
    }
    const n = candidates.length;
    return candidates.map((c)=>({
            hit: c.hit,
            score: [
                ...new Set(c.matched)
            ].reduce((sum, term)=>sum + Math.log(1 + n / df.get(term)), 0) + Math.min(c.rank, 0.99) / 10
        })).sort((a, b)=>b.score - a.score).slice(0, k).map(({ hit, score })=>({
            ...hit,
            score: Math.round(score * 1000) / 1000
        }));
}
const PURPOSE_MAX = 240;
function normalizeKbPurpose(value) {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) return null;
    return trimmed.slice(0, PURPOSE_MAX);
}
function readKbPurpose(metadata) {
    if (!isRecord(metadata)) return null;
    return normalizeKbPurpose(typeof metadata.purpose === 'string' ? metadata.purpose : null);
}
function assembleKbCatalog(input) {
    const artifactByDoc = new Map();
    for (const artifact of input.artifacts){
        if (artifact.status !== 'published' || !artifact.sourceDocumentId) continue;
        artifactByDoc.set(artifact.sourceDocumentId, artifact.id);
    }
    const pagesByArtifact = new Map();
    for (const entry of input.entries){
        if (entry.path === 'index.md') continue;
        const pages = pagesByArtifact.get(entry.artifactId) ?? [];
        pages.push({
            path: entry.path,
            title: entry.title
        });
        pagesByArtifact.set(entry.artifactId, pages);
    }
    const sources = input.docs.map((doc)=>{
        const purpose = readKbPurpose(doc.metadata);
        const artifactId = artifactByDoc.get(doc.id);
        if (artifactId && doc.processingMode === 'okf') {
            const pages = (pagesByArtifact.get(artifactId) ?? []).sort((a, b)=>a.path.localeCompare(b.path));
            return {
                documentId: doc.id,
                filename: doc.filename,
                kind: 'wiki',
                purpose,
                chars: doc.chars,
                artifactId,
                pageCount: pages.length,
                pages
            };
        }
        return {
            documentId: doc.id,
            filename: doc.filename,
            kind: 'file',
            purpose,
            chars: doc.chars
        };
    }).sort((a, b)=>a.filename.localeCompare(b.filename));
    return {
        sources
    };
}
function unquoteYaml(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith('"')) {
        try {
            const parsed = JSON.parse(trimmed);
            return typeof parsed === 'string' ? parsed : trimmed;
        } catch  {
            return trimmed.replace(/^"|"$/g, '');
        }
    }
    return trimmed;
}
function okfIndexFile(bundle) {
    if (!isRecord(bundle) || !Array.isArray(bundle.files)) return null;
    const file = bundle.files.find((entry)=>isRecord(entry) && entry.path === 'index.md' && typeof entry.content === 'string');
    if (!file || !isRecord(file) || typeof file.content !== 'string') return null;
    const content = file.content;
    const fm = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const titleLine = (fm?.[1] ?? content).match(/^title:\s*(.+)$/m);
    const title = titleLine ? unquoteYaml(titleLine[1]) : 'index.md';
    const text = (fm ? fm[2] : content).trim();
    if (!text) return null;
    return {
        title,
        text
    };
}
const KB_DOCUMENT_INLINE_CHARS = 8_000;
/** Fix méretű lapozás, ha a nyers fájlnak nincs `#`/`##`/`###` headingje. */ function windowSections(text) {
    const windows = [];
    for(let start = 0; start < text.length; start += KB_DOCUMENT_INLINE_CHARS){
        const end = Math.min(start + KB_DOCUMENT_INLINE_CHARS, text.length);
        windows.push({
            title: `Part ${windows.length + 1} (chars ${start + 1}-${end})`,
            body: text.slice(start, end)
        });
    }
    return windows;
}
function splitKbSegments(text) {
    return text.split(/\n(?=#{1,3}[ \t])/);
}
const KB_SECTION_SPLIT_SQL = '\\n(?=#{1,3}[ \\t])';
const KB_SECTION_PATH_SEPARATOR = ' › ';
/**
 * Heading-szakaszok egyedi, útvonal-szerű címmel (`Szülő › Gyerek`); a törzs a
 * teljes részfa (al-headingekkel együtt). Egyetlen, legfelső `#` cím nem kerül
 * minden útvonal elejére. Heading nélküli szövegnél fix ablakok.
 */ function outlineSections(text) {
    const segments = splitKbSegments(text);
    const headed = [];
    segments.forEach((seg, segment)=>{
        const heading = seg.replace(/^\n+/, '').split('\n', 1)[0].match(/^(#{1,3})[ \t]+(.*)$/);
        if (heading) headed.push({
            segment,
            level: heading[1].length,
            title: heading[2].trim()
        });
    });
    if (headed.length === 0) {
        return text.trim() ? windowSections(text).map((w)=>({
                ...w,
                segment: -1
            })) : [];
    }
    const soleRoot = headed.filter((h)=>h.level === 1).length === 1 && headed[0].level === 1;
    const stack = [];
    const seen = new Map();
    return headed.map((h, i)=>{
        while(stack.length > 0 && stack[stack.length - 1].level >= h.level)stack.pop();
        const ancestors = stack.filter((a, idx)=>!(soleRoot && idx === 0 && a.level === 1));
        stack.push({
            level: h.level,
            title: h.title
        });
        let path = [
            ...ancestors.map((a)=>a.title),
            h.title
        ].join(KB_SECTION_PATH_SEPARATOR);
        const count = (seen.get(path) ?? 0) + 1;
        seen.set(path, count);
        if (count > 1) path = `${path} (${count})`;
        // A részfa a következő azonos/magasabb szintű headingig tart.
        const next = headed.slice(i + 1).find((later)=>later.level <= h.level);
        const end = next ? next.segment : segments.length;
        const own = segments[h.segment].replace(/^\n*[^\n]*\n?/, '');
        const body = [
            own,
            ...segments.slice(h.segment + 1, end)
        ].join('\n').trim();
        return {
            title: path,
            body,
            segment: h.segment
        };
    });
}
function kbSectionForSegment(text, segment) {
    return outlineSections(text).find((section)=>section.segment === segment)?.title;
}
function normalizeSectionNeedle(value) {
    return value.trim().toLowerCase().replace(/\s*(›|>)\s*/g, KB_SECTION_PATH_SEPARATOR);
}
/** Pontos útvonal → egyedi pontos utolsó cím → egyedi részleges egyezés. */ function findSection(sections, query) {
    const needle = normalizeSectionNeedle(query);
    const exact = sections.find((s)=>s.title.toLowerCase() === needle);
    if (exact) return {
        hit: exact
    };
    const leaf = (s)=>s.title.split(KB_SECTION_PATH_SEPARATOR).pop().toLowerCase();
    const byLeaf = sections.filter((s)=>leaf(s) === needle);
    if (byLeaf.length === 1) return {
        hit: byLeaf[0]
    };
    if (byLeaf.length > 1) return {
        matches: byLeaf.map((s)=>s.title)
    };
    const partial = sections.filter((s)=>s.title.toLowerCase().includes(needle));
    if (partial.length === 1) return {
        hit: partial[0]
    };
    return {
        matches: partial.map((s)=>s.title)
    };
}
function assembleKbDocument(input) {
    const sections = outlineSections(input.text);
    const outline = sections.map((section)=>section.title);
    const base = {
        found: true,
        kind: 'file',
        documentId: input.documentId,
        filename: input.filename,
        purpose: input.purpose,
        chars: input.text.length
    };
    const section = input.section?.trim();
    if (section) {
        const found = findSection(sections, section);
        if (!('hit' in found)) {
            return {
                ...base,
                truncated: true,
                section,
                sectionFound: false,
                // Többértelmű név: csak a jelöltek, nem a teljes vázlat.
                ...found.matches.length > 0 ? {
                    matches: found.matches
                } : {
                    outline
                }
            };
        }
        const hit = found.hit;
        const truncated = hit.body.length > KB_DOCUMENT_INLINE_CHARS;
        return {
            ...base,
            truncated,
            section,
            sectionFound: true,
            text: truncated ? hit.body.slice(0, KB_DOCUMENT_INLINE_CHARS) : hit.body
        };
    }
    if (input.text.length <= KB_DOCUMENT_INLINE_CHARS) {
        return {
            ...base,
            truncated: false,
            text: input.text
        };
    }
    return {
        ...base,
        truncated: true,
        outline
    };
}
}),
"[project]/src/repositories/postgres/knowledge-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresDocumentRepository",
    ()=>PostgresDocumentRepository,
    "PostgresKnowledgeArtifactRepository",
    ()=>PostgresKnowledgeArtifactRepository,
    "PostgresKnowledgeChunkRepository",
    ()=>PostgresKnowledgeChunkRepository,
    "kbQueryTerms",
    ()=>kbQueryTerms,
    "toKbTsQuery",
    ()=>toKbTsQuery
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__ = __turbopack_context__.i("[externals]/@prisma/client [external] (@prisma/client, cjs, [project]/node_modules/@prisma/client)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$kb$2d$retrieval$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/kb-retrieval.ts [app-rsc] (ecmascript)");
;
;
;
function kbQueryTerms(query) {
    const seen = new Set();
    for (const token of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)){
        if (token.length >= 2) seen.add(token);
    }
    return [
        ...seen
    ];
}
function toKbTsQuery(query) {
    return kbQueryTerms(query).map((token)=>`${token}:*`).join(' | ');
}
/**
 * Magyar szótövezés + stopszó-szűrés (Postgres `hungarian` snowball): a
 * „színkódot" a „színkód"-ot is megtalálja, a „hogyan/az/milyen" kiesik. A
 * `knowledge_chunks_fts_hu_idx` ugyanerre a kifejezésre épül.
 */ const KB_FTS_CONFIG = __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].sql`'hungarian'::regconfig`;
/** A kérdésszavak közül azok, amelyek a szakaszban szerepelnek (IDF-újrarangsoroláshoz). */ function kbMatchedTermsSql(vector, terms) {
    return __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].sql`ARRAY(
    SELECT t.term FROM unnest(${terms}::text[]) AS t(term)
    WHERE ${vector} @@ to_tsquery(${KB_FTS_CONFIG}, t.term || ':*')
  )`;
}
/** Jelölt-sorrend: több fedett kérdésszó előbb, holtversenyben ts_rank. */ function kbCandidateOrderSql(vector, terms, tsquery) {
    return __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].sql`cardinality(${kbMatchedTermsSql(vector, terms)}) DESC,
    ts_rank(${vector}, to_tsquery(${KB_FTS_CONFIG}, ${tsquery})) DESC`;
}
class PostgresDocumentRepository {
    async create(data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].document.create({
            data: {
                tenantId: data.tenantId,
                filename: data.filename,
                storageRef: data.storageRef ?? null,
                extractedText: data.extractedText ?? null,
                mimeType: data.mimeType ?? null,
                contentHash: data.contentHash ?? null,
                status: data.status ?? 'uploaded',
                processingMode: data.processingMode ?? null,
                metadata: data.metadata ?? {},
                connectorId: data.connectorId ?? null,
                uploadedById: data.uploadedById
            }
        });
    }
    async findById(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].document.findUnique({
            where: {
                id
            }
        });
    }
    async findByConnectorId(connectorId) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].document.findMany({
            where: {
                connectorId,
                status: 'processed'
            },
            orderBy: {
                createdAt: 'desc'
            }
        });
    }
    async listByConnectorId(connectorId) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].document.findMany({
            where: {
                connectorId
            },
            select: {
                id: true,
                filename: true,
                status: true,
                processingMode: true,
                mimeType: true,
                createdAt: true,
                connectorId: true,
                metadata: true
            },
            orderBy: {
                createdAt: 'desc'
            }
        });
        return rows.map(({ metadata, ...row })=>({
                ...row,
                purpose: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$kb$2d$retrieval$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["readKbPurpose"])(metadata)
            }));
    }
    async listCatalog(connectorId) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$queryRaw`
      SELECT id, filename, processing_mode, metadata,
             char_length(coalesce(extracted_text, ''))::int AS chars
      FROM documents
      WHERE connector_id = ${connectorId}::uuid
        AND status = CAST('processed' AS "DocumentStatus")
      ORDER BY filename ASC
    `;
        return rows.map((row)=>({
                id: row.id,
                filename: row.filename,
                processingMode: row.processing_mode,
                metadata: row.metadata,
                chars: Number(row.chars)
            }));
    }
    async searchRaw(connectorId, query, limit) {
        const terms = kbQueryTerms(query);
        const tsquery = toKbTsQuery(query);
        if (!tsquery || limit <= 0) return [];
        // Szakasz-szintű keresés: a raw fájl heading-szakaszai külön versenyeznek,
        // hogy egy hosszú fájl ne nyerjen pusztán a hossza miatt.
        // ponytail: sequential scan + futásidejű vágás; GIN/tárolt szakaszok, ha a raw korpusz nő.
        const vector = __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].sql`to_tsvector(${KB_FTS_CONFIG}, s.body)`;
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$queryRaw`
      SELECT d.id, d.filename, d.extracted_text, s.ord,
             ts_rank(${vector}, to_tsquery(${KB_FTS_CONFIG}, ${tsquery})) AS score,
             ${kbMatchedTermsSql(vector, terms)} AS matched,
             ts_headline(
               ${KB_FTS_CONFIG},
               s.body,
               to_tsquery(${KB_FTS_CONFIG}, ${tsquery}),
               'MaxWords=40, MinWords=12, MaxFragments=1, StartSel="", StopSel=""'
             ) AS snippet
      FROM documents d
      CROSS JOIN LATERAL regexp_split_to_table(coalesce(d.extracted_text, ''), ${__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$kb$2d$retrieval$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["KB_SECTION_SPLIT_SQL"]})
        WITH ORDINALITY AS s(body, ord)
      WHERE d.connector_id = ${connectorId}::uuid
        AND d.status = CAST('processed' AS "DocumentStatus")
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_artifacts a
          WHERE a.source_document_id = d.id
            AND a.status = CAST('published' AS "KnowledgeArtifactStatus")
        )
        AND ${vector} @@ to_tsquery(${KB_FTS_CONFIG}, ${tsquery})
      ORDER BY ${kbCandidateOrderSql(vector, terms, tsquery)}
      LIMIT ${limit}
    `;
        return rows.map((row)=>({
                id: row.id,
                filename: row.filename,
                section: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$kb$2d$retrieval$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["kbSectionForSegment"])(row.extracted_text, Number(row.ord) - 1),
                snippet: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$kb$2d$retrieval$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["snippet"])(row.snippet?.trim() || row.filename),
                score: Number(row.score),
                matched: row.matched
            }));
    }
    async update(id, data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].document.update({
            where: {
                id
            },
            data
        });
    }
    async delete(id) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].document.delete({
            where: {
                id
            }
        });
    }
}
class PostgresKnowledgeArtifactRepository {
    async create(data) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].knowledgeArtifact.create({
            data: {
                ...data,
                validationResult: data.validationResult ?? undefined
            }
        });
    }
    async findById(id) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].knowledgeArtifact.findUnique({
            where: {
                id
            }
        });
    }
    async findByConnector(connectorId, status) {
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].knowledgeArtifact.findMany({
            where: {
                connectorId,
                ...status ? {
                    status
                } : {}
            },
            orderBy: {
                createdAt: 'desc'
            }
        });
    }
    async publishedSourceDocumentIds(connectorIds) {
        if (connectorIds.length === 0) return new Set();
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].knowledgeArtifact.findMany({
            where: {
                connectorId: {
                    in: connectorIds
                },
                status: 'published',
                sourceDocumentId: {
                    not: null
                }
            },
            select: {
                sourceDocumentId: true
            }
        });
        return new Set(rows.map((row)=>row.sourceDocumentId).filter((id)=>Boolean(id)));
    }
    async deleteBySourceDocumentId(documentId) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].knowledgeArtifact.deleteMany({
            where: {
                sourceDocumentId: documentId
            }
        });
    }
}
class PostgresKnowledgeChunkRepository {
    async createMany(rows) {
        if (rows.length === 0) return 0;
        const result = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].knowledgeChunk.createMany({
            data: rows.map((row)=>({
                    ...row,
                    sourceRef: row.sourceRef ?? undefined
                }))
        });
        return result.count;
    }
    async searchChunks(connectorIds, query, limit) {
        const terms = kbQueryTerms(query);
        const tsquery = toKbTsQuery(query);
        if (!tsquery || connectorIds.length === 0 || limit <= 0) return [];
        const vector = __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].sql`to_tsvector(${KB_FTS_CONFIG}, coalesce(c.title, '') || ' ' || c.text)`;
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$queryRaw`
      SELECT c.artifact_id, c.connector_id, c.path, c.title, c.type, c.section, c.text, c.source_ref,
             ts_rank(${vector}, to_tsquery(${KB_FTS_CONFIG}, ${tsquery})) AS score,
             ${kbMatchedTermsSql(vector, terms)} AS matched
      FROM knowledge_chunks c
      INNER JOIN knowledge_artifacts a ON a.id = c.artifact_id
      WHERE c.connector_id IN (${__TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].join(connectorIds.map((id)=>__TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].sql`${id}::uuid`))})
        AND a.status = CAST('published' AS "KnowledgeArtifactStatus")
        AND ${vector} @@ to_tsquery(${KB_FTS_CONFIG}, ${tsquery})
      ORDER BY ${kbCandidateOrderSql(vector, terms, tsquery)}
      LIMIT ${limit}
    `;
        return rows.map((row)=>({
                artifactId: row.artifact_id,
                connectorId: row.connector_id,
                path: row.path,
                title: row.title,
                type: row.type,
                section: row.section,
                text: row.text,
                sourceRef: row.source_ref,
                score: Number(row.score),
                matched: row.matched
            }));
    }
    async listIndex(connectorIds, pathPrefix, artifactId) {
        if (connectorIds.length === 0) return [];
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].knowledgeChunk.findMany({
            where: {
                connectorId: {
                    in: connectorIds
                },
                artifact: {
                    status: 'published'
                },
                ...pathPrefix ? {
                    path: {
                        startsWith: pathPrefix
                    }
                } : {},
                ...artifactId ? {
                    artifactId
                } : {}
            },
            distinct: [
                'artifactId',
                'path'
            ],
            select: {
                artifactId: true,
                connectorId: true,
                path: true,
                title: true,
                type: true
            },
            orderBy: {
                path: 'asc'
            }
        });
        return rows;
    }
    async getPageChunks(connectorIds, path, artifactId) {
        if (connectorIds.length === 0) return [];
        return __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].knowledgeChunk.findMany({
            where: {
                connectorId: {
                    in: connectorIds
                },
                path,
                artifact: {
                    status: 'published'
                },
                ...artifactId ? {
                    artifactId
                } : {}
            },
            select: {
                artifactId: true,
                connectorId: true,
                path: true,
                title: true,
                type: true,
                section: true,
                chunkIndex: true,
                text: true,
                sourceRef: true
            },
            orderBy: {
                chunkIndex: 'asc'
            }
        });
    }
    async deleteByArtifact(artifactId) {
        await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].knowledgeChunk.deleteMany({
            where: {
                artifactId
            }
        });
    }
}
}),
"[project]/src/repositories/postgres/project-work-repository.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "PostgresProjectMemoryRepository",
    ()=>PostgresProjectMemoryRepository,
    "PostgresWorkFileRepository",
    ()=>PostgresWorkFileRepository,
    "PostgresWorkProjectRepository",
    ()=>PostgresWorkProjectRepository,
    "findAgentMemoryWriteMode",
    ()=>findAgentMemoryWriteMode,
    "updateAgentMemoryWriteMode",
    ()=>updateAgentMemoryWriteMode
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__ = __turbopack_context__.i("[externals]/@prisma/client [external] (@prisma/client, cjs, [project]/node_modules/@prisma/client)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
;
;
function mapProject(row) {
    return row;
}
function mapFile(row) {
    return row;
}
function mapMemory(row) {
    return row;
}
class PostgresWorkProjectRepository {
    async listByTenant(tenantId) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].workProject.findMany({
            where: {
                tenantId
            },
            orderBy: {
                name: 'asc'
            }
        });
        return rows.map(mapProject);
    }
    async findByKey(tenantId, key) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].workProject.findUnique({
            where: {
                tenantId_key: {
                    tenantId,
                    key
                }
            }
        });
        return row ? mapProject(row) : null;
    }
    async create(input) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].workProject.create({
            data: input
        });
        return mapProject(row);
    }
}
class PostgresWorkFileRepository {
    async list(tenantId, projectKey, prefix) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].workFile.findMany({
            where: {
                tenantId,
                projectKey,
                ...prefix ? {
                    path: {
                        startsWith: prefix
                    }
                } : {}
            },
            orderBy: {
                path: 'asc'
            },
            select: {
                id: true,
                tenantId: true,
                projectKey: true,
                path: true,
                byteSize: true,
                lastWriterUserId: true,
                createdAt: true,
                updatedAt: true
            }
        });
        return rows;
    }
    async find(tenantId, projectKey, path) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].workFile.findUnique({
            where: {
                tenantId_projectKey_path: {
                    tenantId,
                    projectKey,
                    path
                }
            }
        });
        return row ? mapFile(row) : null;
    }
    async upsert(input) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].workFile.upsert({
            where: {
                tenantId_projectKey_path: {
                    tenantId: input.tenantId,
                    projectKey: input.projectKey,
                    path: input.path
                }
            },
            create: input,
            update: {
                content: input.content,
                byteSize: input.byteSize,
                lastWriterUserId: input.lastWriterUserId
            }
        });
        return mapFile(row);
    }
    async delete(tenantId, projectKey, path) {
        try {
            await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].workFile.delete({
                where: {
                    tenantId_projectKey_path: {
                        tenantId,
                        projectKey,
                        path
                    }
                }
            });
            return true;
        } catch (error) {
            if (error instanceof __TURBOPACK__imported__module__$5b$externals$5d2f40$prisma$2f$client__$5b$external$5d$__$2840$prisma$2f$client$2c$__cjs$2c$__$5b$project$5d2f$node_modules$2f40$prisma$2f$client$29$__["Prisma"].PrismaClientKnownRequestError && error.code === 'P2025') return false;
            throw error;
        }
    }
    async quota(tenantId, projectKey) {
        const [count, agg] = await Promise.all([
            __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].workFile.count({
                where: {
                    tenantId,
                    projectKey
                }
            }),
            __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].workFile.aggregate({
                where: {
                    tenantId,
                    projectKey
                },
                _sum: {
                    byteSize: true
                }
            })
        ]);
        return {
            count,
            bytes: agg._sum.byteSize ?? 0
        };
    }
}
class PostgresProjectMemoryRepository {
    async listActive(input) {
        const rows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].projectMemoryItem.findMany({
            where: {
                tenantId: input.tenantId,
                agentId: input.agentId,
                projectKey: input.projectKey,
                status: 'active',
                ...input.withUserId ? {
                    withUserId: input.withUserId
                } : {}
            },
            orderBy: {
                createdAt: 'asc'
            }
        });
        return rows.map(mapMemory);
    }
    async findById(id) {
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].projectMemoryItem.findUnique({
            where: {
                id
            }
        });
        return row ? mapMemory(row) : null;
    }
    async insertActive(input) {
        const { alsoSupersedeIds, ...data } = input;
        const retire = [
            ...new Set([
                data.supersedesId,
                ...alsoSupersedeIds
            ].filter((id)=>!!id))
        ];
        const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].$transaction(async (tx)=>{
            if (retire.length > 0) {
                // CAS: két párhuzamos csere közül csak az egyik nyerhet.
                const { count } = await tx.projectMemoryItem.updateMany({
                    where: {
                        id: {
                            in: retire
                        },
                        status: 'active'
                    },
                    data: {
                        status: 'superseded'
                    }
                });
                if (count !== retire.length) throw new Error('memory_not_found');
            }
            return tx.projectMemoryItem.create({
                data: {
                    ...data,
                    status: 'active'
                }
            });
        });
        return mapMemory(row);
    }
}
async function findAgentMemoryWriteMode(agentId, tenantId) {
    const row = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.findFirst({
        where: {
            id: agentId,
            tenantId
        },
        select: {
            memoryWriteMode: true
        }
    });
    return row?.memoryWriteMode ?? null;
}
async function updateAgentMemoryWriteMode(agentId, memoryWriteMode) {
    await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].agent.update({
        where: {
            id: agentId
        },
        data: {
            memoryWriteMode
        }
    });
}
}),
"[project]/src/repositories/postgres/index.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "repositories",
    ()=>repositories
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$agent$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/agent-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$agent$2d$definition$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/agent-definition-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$connector$2d$grant$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/connector-grant-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$connector$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/connector-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$connector$2d$draft$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/connector-draft-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$connector$2d$template$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/connector-template-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$self$2d$updating$2d$connector$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/self-updating-connector-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$platform$2d$settings$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/platform-settings-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/audit-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$gateway$2d$operation$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/gateway-operation-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$resource$2d$grant$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/resource-grant-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$skill$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/skill-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$iam$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/iam-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$tenant$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/tenant-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$knowledge$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/knowledge-repository.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$project$2d$work$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/project-work-repository.ts [app-rsc] (ecmascript)");
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
const repositories = {
    users: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$iam$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresUserRepository"](),
    invitations: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$iam$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresInvitationRepository"](),
    rolePermissions: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$iam$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresRolePermissionRepository"](),
    tenants: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$tenant$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresTenantRepository"](),
    tenantMemberships: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$tenant$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresTenantMembershipRepository"](),
    platformMemberships: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$tenant$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresPlatformMembershipRepository"](),
    agents: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$agent$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresAgentRepository"](),
    agentDefinitions: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$agent$2d$definition$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresAgentDefinitionRepository"](),
    resourceGrants: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$resource$2d$grant$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresResourceGrantRepository"](),
    skills: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$skill$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresSkillRepository"](),
    connectorGrants: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$connector$2d$grant$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresConnectorGrantRepository"](),
    connectors: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$connector$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresConnectorRepository"](),
    connectorDrafts: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$connector$2d$draft$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresConnectorDraftRepository"](),
    connectorTemplates: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$connector$2d$template$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresConnectorTemplateRepository"](),
    selfUpdatingConnectors: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$self$2d$updating$2d$connector$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresSelfUpdatingConnectorRepository"](),
    platformSettings: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$platform$2d$settings$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresPlatformSettingsRepository"](),
    gatewayOperations: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$gateway$2d$operation$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresGatewayOperationRepository"](),
    audit: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$audit$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresAuditRepository"](),
    documents: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$knowledge$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresDocumentRepository"](),
    knowledgeArtifacts: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$knowledge$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresKnowledgeArtifactRepository"](),
    knowledgeChunks: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$knowledge$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresKnowledgeChunkRepository"](),
    workProjects: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$project$2d$work$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresWorkProjectRepository"](),
    workFiles: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$project$2d$work$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresWorkFileRepository"](),
    projectMemory: new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$project$2d$work$2d$repository$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["PostgresProjectMemoryRepository"]()
};
}),
"[externals]/node:crypto [external] (node:crypto, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:crypto", () => require("node:crypto"));

module.exports = mod;
}),
"[externals]/node:async_hooks [external] (node:async_hooks, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:async_hooks", () => require("node:async_hooks"));

module.exports = mod;
}),
"[project]/src/auth/types.ts [app-rsc] (ecmascript) <locals>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "assertActive",
    ()=>assertActive,
    "assertRole",
    ()=>assertRole
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/iam-policy.ts [app-rsc] (ecmascript)");
;
;
function assertActive(user) {
    if (user.status !== 'active') {
        throw new Error(`Account not active (status=${user.status})`);
    }
}
function assertRole(user, required) {
    assertActive(user);
    if (!user.role) {
        throw new Error('No role assigned');
    }
    if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["hasMinimumRole"])(user.role, required)) {
        throw new Error('Insufficient permissions');
    }
}
}),
"[project]/src/auth/clerk-user-sync.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "DomainNotAllowedError",
    ()=>DomainNotAllowedError,
    "syncClerkUser",
    ()=>syncClerkUser
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/iam-policy.ts [app-rsc] (ecmascript)");
;
class DomainNotAllowedError extends Error {
    constructor(email){
        super(`Domain not allowed for self-registration: ${email}`);
        this.name = 'DomainNotAllowedError';
    }
}
function pickBestEmailMatch(users) {
    if (users.length === 0) return null;
    return [
        ...users
    ].sort((a, b)=>{
        // Prefer pre-provisioned rows so first login claims the admin-prepared account
        // instead of a stale duplicate (email is not unique in the schema).
        const aPre = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isPreProvisionedAuthId"])(a.externalAuthId) ? 1 : 0;
        const bPre = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isPreProvisionedAuthId"])(b.externalAuthId) ? 1 : 0;
        if (bPre !== aPre) return bPre - aPre;
        const roleDelta = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ROLE_RANK"][b.role ?? 'viewer'] - __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ROLE_RANK"][a.role ?? 'viewer'];
        if (roleDelta !== 0) return roleDelta;
        return a.createdAt.getTime() - b.createdAt.getTime();
    })[0];
}
function updateData(input, currentRole) {
    return {
        email: input.email,
        name: input.name,
        // The provider proves identity only. Authorization is granted exclusively
        // by a locally validated invitation or an internal approval workflow.
        role: currentRole ?? null
    };
}
function emailsEqual(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}
function userMatchesSyncData(user, data) {
    return emailsEqual(user.email, data.email) && user.name === data.name && user.role === data.role;
}
async function findBestUserByEmail(prisma, email) {
    const emailMatches = await prisma.user.findMany({
        where: {
            email: {
                equals: email,
                mode: 'insensitive'
            }
        }
    });
    return pickBestEmailMatch(emailMatches);
}
async function syncClerkUser(prisma, input) {
    const existingByAuthId = await prisma.user.findUnique({
        where: {
            externalAuthId: input.externalAuthId
        }
    });
    if (existingByAuthId) {
        if (existingByAuthId.status === 'pending' && existingByAuthId.role !== null && !(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isPreProvisionedAuthId"])(existingByAuthId.externalAuthId)) {
            const { services } = await __turbopack_context__.A("[project]/src/domain/gateway-services.ts [app-rsc] (ecmascript, async loader)");
            return services.iam.activateProvisionedUser({
                user: existingByAuthId,
                name: input.name
            });
        }
        const existingByEmail = await findBestUserByEmail(prisma, input.email);
        const data = updateData(input, existingByEmail?.role ?? existingByAuthId.role);
        if (userMatchesSyncData(existingByAuthId, data)) {
            return existingByAuthId;
        }
        return prisma.user.update({
            where: {
                id: existingByAuthId.id
            },
            data
        });
    }
    const existingByEmail = await findBestUserByEmail(prisma, input.email);
    if (existingByEmail) {
        if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isPreProvisionedAuthId"])(existingByEmail.externalAuthId)) {
            // Lazy import: avoids auth ↔ domain circular init at module load.
            const { services } = await __turbopack_context__.A("[project]/src/domain/gateway-services.ts [app-rsc] (ecmascript, async loader)");
            return services.iam.claimPreProvisionedUser({
                user: existingByEmail,
                externalAuthId: input.externalAuthId,
                name: input.name
            });
        }
        if (existingByEmail.status === 'pending' && existingByEmail.role !== null) {
            const { services } = await __turbopack_context__.A("[project]/src/domain/gateway-services.ts [app-rsc] (ecmascript, async loader)");
            return services.iam.activateProvisionedUser({
                user: existingByEmail,
                externalAuthId: input.externalAuthId,
                name: input.name
            });
        }
        const data = {
            externalAuthId: input.externalAuthId,
            ...updateData(input, existingByEmail.role)
        };
        if (existingByEmail.externalAuthId === data.externalAuthId && userMatchesSyncData(existingByEmail, data)) {
            return existingByEmail;
        }
        return prisma.user.update({
            where: {
                id: existingByEmail.id
            },
            data
        });
    }
    // Új személy: opcionális domain-allowlist, egyébként `pending` + `role = NULL`
    // (§7/B). A Clerk publicMetadata nem emelhet belső jogosultságot.
    // (deny-by-default, N-IAM-2/3) — csak admin-jóváhagyás után fér bármihez.
    const allowlist = process.env.IAM_SELF_REGISTER_ALLOWED_DOMAINS;
    if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$iam$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isEmailDomainAllowed"])(input.email, allowlist)) {
        throw new DomainNotAllowedError(input.email);
    }
    const created = await prisma.user.create({
        data: {
            externalAuthId: input.externalAuthId,
            email: input.email,
            name: input.name,
            role: null,
            status: 'pending'
        }
    });
    return created;
}
}),
"[project]/src/auth/clerk-provider.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ClerkAuthProvider",
    ()=>ClerkAuthProvider
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$app$2d$router$2f$server$2f$auth$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@clerk/nextjs/dist/esm/app-router/server/auth.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$app$2d$router$2f$server$2f$currentUser$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@clerk/nextjs/dist/esm/app-router/server/currentUser.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$types$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/src/auth/types.ts [app-rsc] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$clerk$2d$user$2d$sync$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/auth/clerk-user-sync.ts [app-rsc] (ecmascript)");
;
;
;
;
function toAuthUser(user) {
    return {
        id: user.id,
        externalAuthId: user.externalAuthId,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        tenantId: null
    };
}
class ClerkAuthProvider {
    async getCurrentUser() {
        // Gyors út: a session-JWT helyben ellenőrizhető (`auth()`), nem kell a Clerk
        // Backend API-hoz menni. Ismert, aktív fiókhoz a DB-sor elég — a `currentUser()`
        // hálózati kör + e-mail sync csak az első belépéshez / aktiváláshoz kell.
        // ponytail: aktív usernél a Clerk-oldali név/e-mail változás nem szinkronizálódik
        // vissza; ha kell, Clerk `user.updated` webhook írja a User sort.
        const { userId } = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$app$2d$router$2f$server$2f$auth$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["auth"])();
        if (!userId) return null;
        const known = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.findUnique({
            where: {
                externalAuthId: userId
            }
        });
        if (known && known.status === 'active') return toAuthUser(known);
        const clerkUser = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$app$2d$router$2f$server$2f$currentUser$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["currentUser"])();
        if (!clerkUser) return null;
        const externalAuthId = clerkUser.id;
        const primaryEmail = clerkUser.primaryEmailAddress;
        if (!primaryEmail || primaryEmail.verification?.status !== 'verified') return null;
        const email = primaryEmail.emailAddress;
        const name = [
            clerkUser.firstName,
            clerkUser.lastName
        ].filter(Boolean).join(' ') || clerkUser.username || email;
        let user;
        try {
            user = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$clerk$2d$user$2d$sync$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["syncClerkUser"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"], {
                externalAuthId,
                email,
                name
            });
        } catch (err) {
            // §7/B: domain-allowlist elutasítás ⇒ nincs belső fiók, a hívó úgy kezeli,
            // mintha nem lenne bejelentkezve (nem szivárog "van fiók, de tiltva" infó).
            if (err instanceof __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$clerk$2d$user$2d$sync$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["DomainNotAllowedError"]) return null;
            throw err;
        }
        return toAuthUser(user);
    }
    async requireRole(minimum) {
        const { userId } = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$clerk$2f$nextjs$2f$dist$2f$esm$2f$app$2d$router$2f$server$2f$auth$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["auth"])();
        if (!userId) throw new Error('Unauthorized');
        const user = await this.getCurrentUser();
        if (!user) throw new Error('Unauthorized');
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$types$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__["assertRole"])(user, minimum);
        return user;
    }
}
}),
"[project]/src/auth/dev-provider.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "DevAuthProvider",
    ()=>DevAuthProvider
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/db.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$types$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/src/auth/types.ts [app-rsc] (ecmascript) <locals>");
;
;
function devRole() {
    const role = process.env.DEV_AUTH_ROLE;
    if (role === 'admin' || role === 'approver' || role === 'operator' || role === 'viewer') {
        return role;
    }
    return 'operator';
}
class DevAuthProvider {
    async getCurrentUser() {
        const externalAuthId = process.env.DEV_AUTH_USER_ID ?? 'dev-user-001';
        const email = process.env.DEV_AUTH_EMAIL ?? 'dev@excellence.ai';
        const name = process.env.DEV_AUTH_NAME ?? 'Dev Operator';
        const role = devRole();
        // Dev-bypass: nincs valódi hitelesítés, ezért a `status`-t is szinkronban
        // tartjuk az env-konfigurált szereppel — a pending-by-default (N-IAM-3) itt
        // nem alkalmazandó, mert ez a mód eleve nem valódi onboarding-út.
        const user = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$db$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["prisma"].user.upsert({
            where: {
                externalAuthId
            },
            create: {
                externalAuthId,
                email,
                name,
                role,
                status: 'active',
                activatedAt: new Date()
            },
            update: {
                email,
                name,
                role,
                status: 'active'
            }
        });
        return {
            id: user.id,
            externalAuthId: user.externalAuthId,
            email: user.email,
            name: user.name,
            role: user.role,
            status: user.status,
            tenantId: null
        };
    }
    async requireRole(minimum) {
        const user = await this.getCurrentUser();
        if (!user) throw new Error('Unauthorized');
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$types$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$locals$3e$__["assertRole"])(user, minimum);
        return user;
    }
}
}),
"[project]/src/auth/index.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "getAuthProvider",
    ()=>getAuthProvider,
    "getCurrentUser",
    ()=>getCurrentUser,
    "requireRole",
    ()=>requireRole
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/clerk-config.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$clerk$2d$provider$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/auth/clerk-provider.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$dev$2d$provider$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/auth/dev-provider.ts [app-rsc] (ecmascript)");
;
;
;
;
let provider = null;
function assertAuthConfigured() {
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isClerkEnabled"])()) return;
    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isDevAuthAllowed"])()) return;
    throw new Error('Clerk authentication is required in production. Set CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.');
}
function getAuthProvider() {
    if (provider) return provider;
    assertAuthConfigured();
    provider = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$clerk$2d$config$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isClerkEnabled"])() ? new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$clerk$2d$provider$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ClerkAuthProvider"]() : new __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$dev$2d$provider$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["DevAuthProvider"]();
    return provider;
}
const getCurrentUser = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["cache"])(async ()=>getAuthProvider().getCurrentUser());
async function requireRole(minimum) {
    return getAuthProvider().requireRole(minimum);
}
}),
"[project]/src/auth/context.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ACTIVE_TENANT_COOKIE",
    ()=>ACTIVE_TENANT_COOKIE,
    "getAuthContext",
    ()=>getAuthContext
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$headers$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/headers.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$index$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/index.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/tenant-policy.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$index$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/auth/index.ts [app-rsc] (ecmascript)");
;
;
;
;
;
const ACTIVE_TENANT_COOKIE = 'active_tenant_id';
async function readActiveTenantCookie() {
    try {
        const store = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$headers$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["cookies"])();
        return store.get(ACTIVE_TENANT_COOKIE)?.value ?? null;
    } catch  {
        // A cookies() dinamikus API — statikus/nem-request kontextusban dobhat; ilyenkor
        // nincs explicit választás, a default-membership útra esünk vissza.
        return null;
    }
}
/**
 * §11.2 / §13/9: visszafelé kompatibilitás. Ha a user-nek még nincs egyetlen
 * TenantMembership sora sem (migráció előtti / egytenantos dev-demo mód), de a
 * legacy `User.tenantId` + aktív szerep megvan, szintetizálunk EGY membershipet,
 * hogy az egytenantos folyamat a migráció után is működjön.
 */ function legacyFallbackMembership(_user) {
    return [];
}
async function resolveAuthContext() {
    const user = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$index$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["getCurrentUser"])();
    if (!user) return null;
    let platformRoles = [];
    let memberships = [];
    // Platform-szerepek és tenant-membershipek külön fetch, hogy az egyik hiba
    // ne nullázza el a másikat (pl. ha a tenant-táblák még nem léteznek, a
    // platform-szerepek akkor is működjenek).
    try {
        const platformRows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$index$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["repositories"].platformMemberships.findByUser(user.id);
        platformRoles = platformRows.filter((r)=>r.status === 'active').map((r)=>r.role);
    } catch  {
        platformRoles = [];
    }
    try {
        const membershipRows = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$index$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["repositories"].tenantMemberships.findByUser(user.id);
        memberships = membershipRows.map((m)=>({
                tenantId: m.tenantId,
                role: m.role,
                status: m.status,
                isDefault: m.isDefault
            }));
    } catch  {
        // A tenant-táblák hiányozhatnak a db push előtt — ilyenkor legacy-only mód.
        memberships = [];
    }
    if (memberships.length === 0) {
        memberships = legacyFallbackMembership(user);
    }
    const requestedTenantId = await readActiveTenantCookie();
    // Superadmin assume: ha a cookie EXPLICIT egy olyan tenantra mutat, ahol a
    // hívónak nincs active membershipje, ez assume-szándék. Ezt a default-membership
    // visszaesés ELŐTT kell eldönteni — különben (ha van bármilyen membershipünk) a
    // resolveActiveTenant mindig a defaultra esne, és az assume soha nem érvényesülne
    // (a fejléc-váltó „beragadna" a default tenantra, §5.3/§9.1).
    const requestedIsActiveMembership = !!requestedTenantId && memberships.some((m)=>m.tenantId === requestedTenantId && m.status === 'active');
    if (requestedTenantId && !requestedIsActiveMembership && (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isSuperadmin"])(platformRoles)) {
        try {
            const tenant = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$index$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["repositories"].tenants.findById(requestedTenantId);
            if (tenant) {
                return {
                    user,
                    platformRoles,
                    memberships,
                    kind: 'tenant',
                    activeTenantId: tenant.id,
                    // A superadmin az assumed tenantban tenant-admin jogkörrel jár el (§3.3/1).
                    activeTenantRole: 'admin',
                    assumed: true
                };
            }
        } catch  {
        // ignore — a normál feloldásra (membership/default/platform) esünk vissza
        }
    }
    const resolved = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$tenant$2d$policy$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["resolveActiveTenant"])({
        memberships,
        platformRoles,
        requestedTenantId
    });
    if (resolved.kind === 'tenant') {
        return {
            user,
            platformRoles,
            memberships,
            kind: 'tenant',
            activeTenantId: resolved.tenantId,
            activeTenantRole: resolved.role,
            assumed: false
        };
    }
    if (resolved.kind === 'platform') {
        return {
            user,
            platformRoles,
            memberships,
            kind: 'platform',
            activeTenantId: null,
            activeTenantRole: null,
            assumed: false
        };
    }
    return {
        user,
        platformRoles,
        memberships,
        kind: 'none',
        activeTenantId: null,
        activeTenantRole: null,
        assumed: false
    };
}
const getAuthContext = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["cache"])(resolveAuthContext);
}),
"[project]/src/i18n/translate.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/** Loose translator for dynamic keys (error codes, nav keys). */ __turbopack_context__.s([
    "asTranslate",
    ()=>asTranslate
]);
function asTranslate(t) {
    return t;
}
}),
"[project]/src/lib/control-plane-nav-i18n.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "localizeControlPlaneNav",
    ()=>localizeControlPlaneNav,
    "navMessageKey",
    ()=>navMessageKey
]);
function navMessageKey(key) {
    return key.replaceAll('.', '_');
}
function localizeControlPlaneNav(nav, t) {
    return nav.map((entry)=>{
        if ('children' in entry) {
            return {
                key: entry.key,
                label: t(navMessageKey(entry.key)),
                children: entry.children.map((child)=>({
                        ...child,
                        label: t(navMessageKey(child.key))
                    }))
            };
        }
        return {
            ...entry,
            label: t(navMessageKey(entry.key))
        };
    });
}
}),
"[project]/src/lib/nav-visibility-server.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "loadTenantNavVisibility",
    ()=>loadTenantNavVisibility
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$index$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/repositories/postgres/index.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/nav-visibility.ts [app-rsc] (ecmascript)");
;
;
;
const loadTenantNavVisibility = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["cache"])(async (tenantId)=>{
    if (!tenantId) return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["emptyNavVisibilityPolicy"])();
    try {
        const tenant = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$repositories$2f$postgres$2f$index$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["repositories"].tenants.findById(tenantId);
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["readNavVisibilityPolicy"])(tenant?.settings);
    } catch  {
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["emptyNavVisibilityPolicy"])();
    }
});
}),
"[project]/src/app/control-plane/control-plane-shell.tsx [app-rsc] (client reference proxy) <module evaluation>", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ControlPlaneRoot",
    ()=>ControlPlaneRoot,
    "ControlPlaneShell",
    ()=>ControlPlaneShell
]);
// This file is generated by next-core EcmascriptClientReferenceModule.
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-server-dom-turbopack-server.js [app-rsc] (ecmascript)");
;
const ControlPlaneRoot = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call ControlPlaneRoot() from the server but ControlPlaneRoot is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/src/app/control-plane/control-plane-shell.tsx <module evaluation>", "ControlPlaneRoot");
const ControlPlaneShell = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call ControlPlaneShell() from the server but ControlPlaneShell is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/src/app/control-plane/control-plane-shell.tsx <module evaluation>", "ControlPlaneShell");
}),
"[project]/src/app/control-plane/control-plane-shell.tsx [app-rsc] (client reference proxy)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ControlPlaneRoot",
    ()=>ControlPlaneRoot,
    "ControlPlaneShell",
    ()=>ControlPlaneShell
]);
// This file is generated by next-core EcmascriptClientReferenceModule.
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-server-dom-turbopack-server.js [app-rsc] (ecmascript)");
;
const ControlPlaneRoot = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call ControlPlaneRoot() from the server but ControlPlaneRoot is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/src/app/control-plane/control-plane-shell.tsx", "ControlPlaneRoot");
const ControlPlaneShell = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$server$2d$dom$2d$turbopack$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["registerClientReference"])(function() {
    throw new Error("Attempted to call ControlPlaneShell() from the server but ControlPlaneShell is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.");
}, "[project]/src/app/control-plane/control-plane-shell.tsx", "ControlPlaneShell");
}),
"[project]/src/app/control-plane/control-plane-shell.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$control$2d$plane$2d$shell$2e$tsx__$5b$app$2d$rsc$5d$__$28$client__reference__proxy$29$__$3c$module__evaluation$3e$__ = __turbopack_context__.i("[project]/src/app/control-plane/control-plane-shell.tsx [app-rsc] (client reference proxy) <module evaluation>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$control$2d$plane$2d$shell$2e$tsx__$5b$app$2d$rsc$5d$__$28$client__reference__proxy$29$__ = __turbopack_context__.i("[project]/src/app/control-plane/control-plane-shell.tsx [app-rsc] (client reference proxy)");
;
__turbopack_context__.n(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$control$2d$plane$2d$shell$2e$tsx__$5b$app$2d$rsc$5d$__$28$client__reference__proxy$29$__);
}),
"[project]/src/app/control-plane/layout.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>ControlPlaneLayout
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$headers$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/headers.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$server$2f$react$2d$server$2f$getTranslations$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__getTranslations$3e$__ = __turbopack_context__.i("[project]/node_modules/next-intl/dist/esm/development/server/react-server/getTranslations.js [app-rsc] (ecmascript) <export default as getTranslations>");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$context$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/auth/context.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-embed.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$nav$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-nav.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$translate$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/i18n/translate.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$nav$2d$i18n$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/control-plane-nav-i18n.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2d$server$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/nav-visibility-server.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$control$2d$plane$2d$shell$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/app/control-plane/control-plane-shell.tsx [app-rsc] (ecmascript)");
;
;
;
;
;
;
;
;
;
;
async function ControlPlaneLayout({ children }) {
    const embed = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$embed$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["isControlPlaneEmbedRequest"])(await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$headers$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["headers"])());
    if (embed) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$control$2d$plane$2d$shell$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ControlPlaneRoot"], {
            embedFromServer: true,
            children: children
        }, void 0, false, {
            fileName: "[project]/src/app/control-plane/layout.tsx",
            lineNumber: 14,
            columnNumber: 12
        }, this);
    }
    const ctx = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$auth$2f$context$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["getAuthContext"])();
    const navVisibility = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$nav$2d$visibility$2d$server$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["loadTenantNavVisibility"])(ctx?.activeTenantId ?? null);
    const tNav = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2d$intl$2f$dist$2f$esm$2f$development$2f$server$2f$react$2d$server$2f$getTranslations$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__$3c$export__default__as__getTranslations$3e$__["getTranslations"])('ControlPlane.nav');
    const navItems = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$nav$2d$i18n$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["localizeControlPlaneNav"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$control$2d$plane$2d$nav$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["buildControlPlaneNav"])({
        tenantRole: ctx?.activeTenantRole ?? null,
        platformRoles: ctx?.platformRoles ?? [],
        navVisibility
    }), (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$i18n$2f$translate$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["asTranslate"])(tNav));
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$app$2f$control$2d$plane$2f$control$2d$plane$2d$shell$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["ControlPlaneRoot"], {
        embedFromServer: false,
        navItems: navItems,
        children: children
    }, void 0, false, {
        fileName: "[project]/src/app/control-plane/layout.tsx",
        lineNumber: 30,
        columnNumber: 5
    }, this);
}
}),
"[project]/src/app/control-plane/layout.tsx [app-rsc] (ecmascript, Next.js Server Component)", ((__turbopack_context__) => {

__turbopack_context__.n(__turbopack_context__.i("[project]/src/app/control-plane/layout.tsx [app-rsc] (ecmascript)"));
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__046bt-4._.js.map