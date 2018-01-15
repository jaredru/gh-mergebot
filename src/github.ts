export interface Repository {
    full_name: string;
}

export interface Issue {
    url: string;
    pull_request?: IssuePullRequestDetails;
}

export interface IssuePullRequestDetails {
    url: string;
}

export interface Comment {
    body: string;
}

export interface IssueComment {
    action: "created" | "edited" | "deleted";
    repository: Repository;
    issue: Issue;
    comment: Comment;
}

export interface Branch {
    ref: string;
    sha: string;
}

export interface PullRequest {
    url: string;
    state: "closed" | "open";

    mergeable: boolean | null;
    mergeable_state: "behind" | "blocked" | "clean" | "unknown";

    base: Branch;
    head: Branch;

    statuses_url: string;
}

export interface StatusUpdate {
    state: "error" | "failure" | "pending" | "success";
    repository: Repository;
}

export interface Statuses {
    state: "failure" | "pending" | "success";
}
