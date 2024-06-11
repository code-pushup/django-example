import type { CoreConfig } from "@code-pushup/models";
import pylintPlugin from "./code-pushup.pylint.plugin";

const config: CoreConfig = {
    plugins: [await pylintPlugin(["django"])],
    categories: [
        {
            slug: "bug-prevention",
            title: "Bug prevention",
            refs: [
                {
                    type: "group",
                    plugin: "pylint",
                    slug: "error",
                    weight: 5,
                },
                {
                    type: "group",
                    plugin: "pylint",
                    slug: "warning",
                    weight: 1,
                },
            ],
        },
        {
            slug: "code-style",
            title: "Code style",
            refs: [
                {
                    type: "group",
                    plugin: "pylint",
                    slug: "refactor",
                    weight: 1,
                },
                {
                    type: "group",
                    plugin: "pylint",
                    slug: "convention",
                    weight: 1,
                },
                {
                    type: "group",
                    plugin: "pylint",
                    slug: "info",
                    weight: 0,
                },
            ],
        },
    ],
    ...(process.env.CP_API_KEY && {
        upload: {
            server: "https://api.staging.code-pushup.dev/graphql",
            apiKey: process.env.CP_API_KEY,
            organization: "code-pushup",
            project: "python-example",
        },
    }),
};

export default config;
