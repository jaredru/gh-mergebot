import * as Koa from "koa";
import * as bodyParser from "koa-bodyparser";
import * as Router from "koa-router";
import fetch, { RequestInit } from "node-fetch";

import * as Github from "./github";

const options = {
    path: "/",
    port: 3000,
    token: "",
};

Object.keys(options).forEach(key => {
    const envValue = process.env[key.toUpperCase()];
    if (envValue) {
        options[key] = envValue;
    } else if (!options[key]) {
        throw new Error(`Missing required config option "${key}".`);
    }
});

const router = new Router();
router
    .get("/health", async (ctx, next) => {
        ctx.status = 200;
    })
    .post(options.path, async (ctx, next) => {
        const event = ctx.request.get("x-github-event");
        const { body } = ctx.request;

        switch (event) {
        case "issue_comment":
            handleGithubIssueComment(body);
            break;

        case "status":
            handleGithubStatusUpdate(body);
            break;
        }

        ctx.status = 200;
    });

const app = new Koa();
app
    .use(bodyParser())
    .use(router.routes())
    .use(router.allowedMethods())
    .listen(options.port);

function handleGithubIssueComment(data: Github.IssueComment) {
    // we don't care about edited or deleted comments
    if (data.action !== "created") {
        return;
    }

    // we don't care about comments on non-PR issues
    if (data.issue.pull_request == null) {
        return;
    }

    // we don't care about comments without merge commands
    const matches = data.comment.body.match(/^\s*!(merge|cancel)\b/);
    if (!matches) {
        return;
    }

    handleMergeCommand({
        action: matches[1],
        repository: data.repository,
        pull_request: data.issue.pull_request,
    });
}

function handleGithubStatusUpdate(data: Github.StatusUpdate) {
    // we don't care about status updates on repos without pending merge requests
    const repo = getRepo(data.repository);
    if (!repo.requests.size) {
        return;
    }

    console.log(`Triggering merge attempt for ${repo.repoId}`);
    tryMerge(repo);
}

interface MergeRequestOptions {
    action: string;
    repository: Github.Repository;
    pull_request: Github.IssuePullRequestDetails;
}

function handleMergeCommand({ action, repository, pull_request}: MergeRequestOptions) {
    const repo = getRepo(repository);
    const prUrl = pull_request.url;

    switch (action) {
    case "merge":
        handleMerge(repo, prUrl);
        break;

    case "cancel":
        handleCancel(repo, prUrl);
        break;
    }
}

function handleMerge(repo: Repository, prUrl: string) {
    console.log(`Requested to merge ${prUrl}`);
    if (repo.requests.has(prUrl)) {
        updateForQueue(repo, prUrl);
        return;
    }

    console.log(`Adding ${prUrl} to merge queue`);
    repo.requests.add(prUrl);

    if (repo.requests.size === 1) {
        console.log(`Triggering merge attempt for ${repo.repoId}`);
        tryMerge(repo, true);
    } else {
        updateForQueue(repo, prUrl);
    }
}

function handleCancel(repo: Repository, prUrl: string) {
    console.log(`Requested to cancel merge for ${prUrl}`);
    if (!repo.requests.has(prUrl)) {
        comment(prUrl, "There was no merge request for this PR.");
        return;
    }

    console.log(`Removing ${prUrl} from merge queue`);
    repo.requests.delete(prUrl);

    comment(prUrl, "OK. Merge request canceled.");
}

function request(url: string, init: RequestInit = {}) {
    return fetch(url, {
        headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `token ${options.token}`,
        },
        ...init,
    });
}

function comment(prUrl: string, body: string) {
    console.log(`Commenting on ${prUrl}: ${body}`);

    const [repoUrl, issueId] = prUrl.split("/pulls/");
    return request(`${repoUrl}/issues/${issueId}/comments`, {
        body: JSON.stringify({ body }),
    });
}

function getPrecedingRequests(repo: Repository, prUrl: string) {
    const precedingRequests = [];
    for (const url of repo.requests.values()) {
        if (url === prUrl) {
            break;
        }

        const [, prId] = prUrl.split("/pulls/");
        precedingRequests.push(prId);
    }

    return precedingRequests;
}

async function updateForQueue(repo: Repository, prUrl: string) {
    const precedingRequests = getPrecedingRequests(repo, prUrl);
    if (precedingRequests.length) {
        comment(prUrl, `I'll merge this after ${precedingRequests.map(r => `#${r}`).join(" ")}.`);
    } else {
        tryMerge(repo, true);
    }
}

async function tryMerge(repo: Repository, isExplicit: boolean = false): Promise<void> {
    const prUrl = repo.requests.values().next().value;
    if (!prUrl) {
        return;
    }

    const prResult = await request(prUrl);
    if (!prResult.ok) {
        const body = await prResult.text();
        throw new Error(`(${prResult.status}) ${prUrl}: ${body}`);
    }

    const pullRequest = await prResult.json() as Github.PullRequest;
    if (pullRequest.state !== "open") {
        console.log(`PR is closed; can't merge: ${prUrl}`);
        repo.requests.delete(prUrl);

        comment(prUrl, "I can't merge this. It's closed.");
        tryMerge(repo);

        return;
    }

    switch (pullRequest.mergeable_state) {
    case "clean":
        handleMergeStateClean(repo, pullRequest);
        break;

    case "behind":
        handleMergeStateBehind(repo, pullRequest);
        break;

    case "blocked":
        handleMergeStateBlocked(repo, pullRequest, isExplicit);
        break;

    default:
        console.error(`Unknown mergeable_state for ${prUrl}: ${pullRequest.mergeable_state}`);
        repo.requests.delete(prUrl);

        comment(pullRequest.url, "I can't merge this. GitHub marked its state with an unexpected value.");
        tryMerge(repo);
    }
}

async function handleMergeStateClean(repo: Repository, pullRequest: Github.PullRequest) {
    if (!pullRequest.mergeable) {
        console.error(`${pullRequest.url} not mergeable: ${pullRequest.mergeable_state}`);
        repo.requests.delete(pullRequest.url);

        comment(pullRequest.url, "I can't merge this. GitHub marked it not mergeable.");
        tryMerge(repo);

        return;
    }

    console.log(`Attempting to merge ${pullRequest.url}`);
    const result = await request(`${pullRequest.url}/merge`, {
        method: "PUT",
        body: JSON.stringify({
            merge_method: "squash",
        }),
    });

    if (result.ok) {
        console.log(`Successfully merged ${pullRequest.url}`);
    } else {
        console.error(`Failed to merge ${pullRequest.url}: ${await result.text()}`);
        comment(pullRequest.url, "I wasn't able to merge this. Sorry.");
    }

    repo.requests.delete(pullRequest.url);
    tryMerge(repo);
}

async function handleMergeStateBehind(repo: Repository, pullRequest: Github.PullRequest) {
    const [repoUrl] = pullRequest.url.split("/pulls");

    console.log(`Attempting to update out-of-date ${pullRequest.url}`);
    const result = await request(`${repoUrl}/merges`, {
        method: "POST",
        body: JSON.stringify({
            base: pullRequest.head.ref,
            head: pullRequest.base.ref,
        }),
    });

    if (result.ok) {
        console.log(`Successfully updated ${pullRequest.url}`);
    } else {
        console.error(`Failed to update ${pullRequest.url}: ${result.status}`);
        comment(pullRequest.url, "I wasn't able to update this PR with its base branch.");
    }

    repo.requests.delete(pullRequest.url);
    tryMerge(repo);
}

async function handleMergeStateBlocked(repo: Repository, pullRequest: Github.PullRequest, isExplicit: boolean) {
    const [repoUrl] = pullRequest.url.split("/pulls/");

    console.log(`Checking combined status for ${pullRequest.url}`);
    const statusesResult = await request(`${repoUrl}/commits/${pullRequest.head.sha}/status`);
    if (!statusesResult.ok) {
        const body = await statusesResult.text();
        throw new Error(`(${statusesResult.status}) ${pullRequest.url}: ${body}`);
    }

    const statuses = await statusesResult.json() as Github.Statuses;
    const { state } = statuses;

    // a pending statuses state is expected, and we'll need to wait
    if (state === "pending") {
        console.log(`Status checks for ${pullRequest.url} are pending`);
        if (isExplicit) {
            comment(pullRequest.url, "I'll merge this after its status checks succeed.");
        }
    } else {
        switch (statuses.state) {
        case "success":
            console.error(`Status checks for ${pullRequest.url} have unexpectedly passed`);
            comment(pullRequest.url, "I can't merge this. GitHub marked its state 'blocked'.");
            break;

        case "failure":
            console.info(`Status checks for ${pullRequest.url} have failed`);
            comment(pullRequest.url, "I can't merge this. Its status checks have failed.");
            break;

        default:
            console.error(`Status checks for ${pullRequest.url} in unexpected state: ${statuses.state}`);
            comment(pullRequest.url, "I can't merge this. Its status checks are in an unexpected state.");
            break;
        }

        repo.requests.delete(pullRequest.url);
        tryMerge(repo);
    }
}

const pendingMerges: {
    [repoName: string]: Set<string>;
} = {};

interface Repository {
    repoId: string;
    requests: Set<string>;
}

function getRepo(data: Github.Repository): Repository {
    const repoId = data.full_name.toLowerCase();
    const requests = pendingMerges[repoId] || (pendingMerges[repoId] = new Set());

    return {
        repoId,
        requests,
    };
}
