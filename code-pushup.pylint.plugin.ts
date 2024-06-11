import type {
    Audit,
    AuditOutput,
    Group,
    Issue,
    IssueSeverity,
    PluginConfig,
} from "@code-pushup/models";
import {
    capitalize,
    compareIssueSeverity,
    countOccurrences,
    executeProcess,
    objectToEntries,
    pluralizeToken,
    truncateIssueMessage,
} from "@code-pushup/utils";

// FOR FUTURE REFERENCE: PyLint has a default scoring formula:
// 10.0 - ((float(5 * error + warning + refactor + convention) / statement) * 10)
// https://pylint.readthedocs.io/en/stable/user_guide/configuration/all-options.html#evaluation

export default async function pylintPlugin(
    patterns: string[]
): Promise<PluginConfig> {
    const enabledMessages = await findEnabledMessages(patterns);
    const audits = listAudits(enabledMessages);
    const groups = listGroups(enabledMessages);

    return {
        slug: "pylint",
        title: "PyLint",
        icon: "python",
        audits,
        groups,
        runner: () => runLint(patterns, audits),
    };
}

type PylintJson2 = {
    messages: PylintMessage[];
    statistics: PylintStatistics;
};

type PylintMessageType =
    | "fatal"
    | "error"
    | "warning"
    | "refactor"
    | "convention"
    | "info";

type PylintMessage = {
    type: PylintMessageType;
    symbol: string;
    message: string;
    messageId: string;
    confidence: string;
    module: string;
    obj: string;
    line: number;
    column: number;
    endLine: number | null;
    endColumn: number | null;
    path: string;
    absolutePath: string;
};

type PylintStatistics = {
    messageTypeCount: Record<PylintMessageType, number>;
    modulesLinted: number;
    score: number;
};

type EnabledMessage = {
    symbol: string;
    messageId: string;
};

async function findEnabledMessages(
    patterns: string[]
): Promise<EnabledMessage[]> {
    const { stdout } = await executeProcess({
        command: "python",
        args: ["-m", "pylint", "--list-msgs-enabled", ...patterns],
    });

    const lines = stdout.split("\n");
    const enabledStart = lines.indexOf("Enabled messages:");
    const enabledEnd = lines.findIndex(
        (line, i) => i > enabledStart && !line.startsWith("  ")
    );
    const enabledLines = lines.slice(enabledStart, enabledEnd);

    return enabledLines
        .map((line): EnabledMessage | null => {
            const match = line.match(/^  ([\w-]+) \(([A-Z]\d+)\)$/);
            if (!match) {
                return null;
            }
            const [, symbol, messageId] = match;
            return { symbol, messageId };
        })
        .filter((msg): msg is EnabledMessage => msg != null);
}

function listAudits(enabledMessages: EnabledMessage[]): Audit[] {
    return enabledMessages.map(({ symbol, messageId }): Audit => {
        const type = messageIdToType(messageId);
        return {
            slug: symbol,
            title: `${symbol} (${messageId})`,
            ...(type && {
                docsUrl: `https://pylint.readthedocs.io/en/stable/user_guide/messages/${type}/${symbol}.html`,
            }),
        };
    });
}

function listGroups(enabledMessages: EnabledMessage[]): Group[] {
    // source: https://github.com/pylint-dev/pylint/blob/main/pylint/config/help_formatter.py#L47-L53
    const descriptions: Record<PylintMessageType, string> = {
        info: "for informational messages",
        convention: "for programming standard violation",
        refactor: "for bad code smell",
        warning: "for python specific problems",
        error: "for probable bugs in the code",
        fatal: "if an error occurred which prevented pylint from doing further processing",
    };

    const categoriesMap = enabledMessages.reduce<Record<string, string[]>>(
        (acc, { symbol, messageId }) => {
            const type = messageIdToType(messageId);
            if (!type) {
                return acc;
            }
            return { ...acc, [type]: [...(acc[type] ?? []), symbol] };
        },
        {}
    );
    return Object.entries(categoriesMap).map(
        ([type, symbols]): Group => ({
            slug: type,
            title: capitalize(type),
            description: descriptions[type],
            docsUrl: `https://pylint.readthedocs.io/en/stable/user_guide/messages/messages_overview.html#${type}`,
            refs: symbols.map((symbol) => ({ slug: symbol, weight: 1 })),
        })
    );
}

function messageIdToType(messageId: string): PylintMessageType | null {
    switch (messageId[0]) {
        case "F":
            return "fatal";
        case "E":
            return "error";
        case "W":
            return "warning";
        case "R":
            return "refactor";
        case "C":
            return "convention";
        case "I":
            return "info";
        default:
            return null;
    }
}

async function runLint(
    patterns: string[],
    audits: Audit[]
): Promise<AuditOutput[]> {
    const { stdout, stderr } = await executeProcess({
        command: "python",
        args: ["-m", "pylint", "--output-format=json2", ...patterns],
        ignoreExitCode: true,
    });

    if (stderr) {
        throw new Error(stderr);
    }

    const result = JSON.parse(stdout) as PylintJson2;

    const issuesMap = result.messages.reduce<Record<string, Issue[]>>(
        (acc, message) => ({
            ...acc,
            [message.symbol]: [
                ...(acc[message.symbol] ?? []),
                messageToIssue(message),
            ],
        }),
        {}
    );

    return audits.map(({ slug }): AuditOutput => {
        const issues = issuesMap[slug] ?? [];

        const severityCounts = countOccurrences(
            issues.map(({ severity }) => severity)
        );
        const severities = objectToEntries(severityCounts);
        const summaryText =
            [...severities]
                .sort((a, b) => -compareIssueSeverity(a[0], b[0]))
                .map(([severity, count = 0]) => pluralizeToken(severity, count))
                .join(", ") || "passed";

        return {
            slug,
            score: Number(issues.length === 0),
            value: issues.length,
            displayValue: summaryText,
            details: { issues },
        };
    });
}

function messageToIssue({
    type,
    message,
    path,
    line,
    column,
    endLine,
    endColumn,
}: PylintMessage): Issue {
    return {
        message: truncateIssueMessage(message.replace(/_/g, "\\_")),
        severity: messageTypeToSeverity(type),
        source: {
            file: path,
            position: {
                startLine: line,
                startColumn: column + 1,
                ...(endLine != null && { endLine }),
                ...(endColumn != null && { endColumn: endColumn + 1 }),
            },
        },
    };
}

function messageTypeToSeverity(type: PylintMessageType): IssueSeverity {
    switch (type) {
        case "fatal":
        case "error":
            return "error";
        case "warning":
            return "warning";
        case "refactor":
        case "convention":
        case "info":
            return "info";
    }
}
