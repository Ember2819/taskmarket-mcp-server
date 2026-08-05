#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "fs/promises";
import fetch from "node-fetch";

const TM_API = "https://api.taskmarket.dev/api";
const TM_BASE = "https://taskmarket.dev";

const getApiKey = () => process.env.TASKMARKET_API_KEY;

async function api(path) {
  const headers = { Accept: "application/json" };
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(TM_API + path, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

function formatTask(t) {
  return {
    id: t.id,
    description: (t.description || "").split("\n")[0],
    reward_usdc: t.reward ? parseInt(t.reward) / 1e6 : null,
    net_reward_usdc: t.netReward ? parseInt(t.netReward) / 1e6 : null,
    status: t.status,
    phase: t.phase,
    mode: t.mode,
    tags: t.tags || [],
    expiry_time: t.expiryTime,
    submission_count: t.submissionCount,
    submission_window_open: t.submissionWindowOpen,
    deadline: t.expiryTime,
  };
}

const server = new Server(
  {
    name: "taskmarket-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "list_tasks",
      description: "List open TaskMarket tasks. Optionally filter by tag or minimum USDC reward.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Filter by tag (e.g. 'ai', 'benchmark', 'proxywar')" },
          min_reward: { type: "number", description: "Minimum reward in USDC" },
          status: { type: "string", description: "Filter by status (default: open)", default: "open" },
        },
      },
    },
    {
      name: "get_task",
      description: "Get detailed information about a specific TaskMarket task by ID.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "The task ID (0x-prefixed hex)" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "submit_work",
      description: "Submit files for a TaskMarket task. Requires TASKMARKET_API_KEY env var.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "The task ID to submit work for" },
          file_paths: { type: "array", items: { type: "string" }, description: "Local file paths to upload" },
          role: { type: "string", description: "Artifact role: preview, source, final, or attachment" },
        },
         required: ["task_id"],
       },
     },
     {
       name: "check_balance",
       description: "Check USDC balance on Base mainnet for the connected wallet.",
       inputSchema: {
         type: "object",
         properties: {
           wallet_address: { type: "string", description: "Wallet address to check (optional, defaults to connected wallet)" },
           api_key: { type: "string", description: "TaskMarket API key (required for authenticated balance)" },
         },
       },
     },
     {
       name: "create_task",
       description: "Create a new TaskMarket task. Requires TaskMarket API key and USDC for the escrow.",
       inputSchema: {
         type: "object",
         properties: {
           description: { type: "string", description: "Full task description" },
           reward_usdc: { type: "number", description: "Reward in USDC" },
           duration_hours: { type: "number", description: "Task deadline in hours" },
           mode: { type: "string", description: "Task mode: bounty, claim, pitch, benchmark, or auction" },
           tags: { type: "array", items: { type: "string" }, description: "Tags for the task" },
           api_key: { type: "string", description: "TaskMarket API key" },
         },
         required: ["description", "reward_usdc", "api_key"],
       },
     },
   ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "list_tasks") {
    const status = args?.status || "open";
    let url = `/tasks?status=${status}`;
    if (args?.tag) url += `&tags=${encodeURIComponent(args.tag)}`;

    const data = await api(url);
    let tasks = data.tasks || [];

    if (args?.min_reward) {
      tasks = tasks.filter((t) => (parseInt(t.reward || 0) / 1e6) >= args.min_reward);
    }

    return {
      content: [
        {
          type: "text",
          text: `Found ${tasks.length} TaskMarket tasks (${status}).` +
            (args?.tag ? ` Filtered by tag: ${args.tag}` : "") +
            (args?.min_reward ? ` Min reward: $${args.min_reward}` : "") +
            "\n\n" +
            tasks.map(formatTask).map((t) =>
              `• ${t.id.slice(0, 16)}… | $${t.reward_usdc ? t.reward_usdc.toFixed(2) : "?"} | ${t.tags.join(", ")} | ${t.description}`
            ).join("\n") +
            "\n\nView: " + TM_BASE + "/tasks/" + (tasks[0]?.id || ""),
        },
      ],
    };
  }

  if (name === "get_task") {
    const taskId = args?.task_id;
    if (!taskId) throw new Error("task_id is required");
    const data = await api(`/tasks/${taskId}`);
    const t = data.task || data;
    if (!t || !t.id) {
      return {
        content: [
          {
            type: "text",
            text: `Task not found or error: ${JSON.stringify(data)[:200]}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(formatTask(t), null, 2) + "\n\nFull description:\n" + (t.description || ""),
        },
      ],
    };
  }

  if (name === "submit_work") {
    const key = getApiKey();
    if (!key) {
      return {
        content: [
          {
            type: "text",
            text: "ERROR: TASKMARKET_API_KEY environment variable is required for submission.",
          },
        ],
      };
    }

    const taskId = args?.task_id;
    const filePaths = args?.file_paths || [];
    const role = args?.role || "final";
    const results = [];

    for (const filePath of filePaths) {
      try {
        const fileContent = await readFile(filePath);
        const formData = new FormData();
        formData.append("file", new Blob([fileContent]), filePath.split("/").pop());
        formData.append("role", role);

        const res = await fetch(`${TM_API}/tasks/${taskId}/submit`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: formData,
        });

        if (res.ok) {
          const r = await res.json();
          results.push(`OK ${filePath}: ${r.submissionId || "submitted"}`);
        } else {
          results.push(`FAIL ${filePath}: HTTP ${res.status}`);
        }
      } catch (e) {
        results.push(`FAIL ${filePath}: ${e.message}`);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Submission results for task ${taskId}:\n` + results.join("\n"),
        },
      ],
    };
  }

   if (name === "check_balance") {
    const apiKey = args?.api_key || getApiKey();
    if (!apiKey) {
      return {
        content: [
          {
            type: "text",
            text: "ERROR: API key is required to check balance. Set TASKMARKET_API_KEY env var or pass api_key parameter.",
          },
        ],
      };
    }

    const res = await fetch(`${TM_API}/wallet/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const t = await res.text();
      return {
        content: [
          {
            type: "text",
            text: `Balance check failed: HTTP ${res.status} ${t.slice(0, 200)}`,
          },
        ],
      };
    }

    const data = await res.json();
    return {
      content: [
        {
          type: "text",
          text: `USDC Balance: ${data.data?.balanceUsdc || data.data?.balance || "0"} USDC\nAddress: ${data.data?.address || "unknown"}\nNetwork: ${data.data?.network || "Base"}`,
        },
      ],
    };
  }

  if (name === "create_task") {
    const key = args?.api_key || getApiKey();
    if (!key) {
      return {
        content: [
          {
            type: "text",
            text: "ERROR: API key is required to create tasks.",
          },
        ],
      };
    }

    const payload = {
      description: args.description,
      reward: Math.round(args.reward_usdc * 1e6),
      duration: args.duration_hours || 24,
      mode: args.mode || "bounty",
      tags: args.tags || [],
    };

    const res = await fetch(`${TM_API}/tasks`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const t = await res.text();
      return {
        content: [
          {
            type: "text",
            text: `Task creation failed: HTTP ${res.status} ${t.slice(0, 200)}`,
          },
        ],
      };
    }

    const result = await res.json();
    return {
      content: [
        {
          type: "text",
          text: `Task created! ID: ${result.data?.id || result.id || "unknown"}\nStatus: ${result.data?.status || "created"}`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("TaskMarket MCP server running on stdio");
