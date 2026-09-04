const en = {
    common: {
        appName: 'Manyfold',
        loading: 'Loading…',
        loadingShort: 'Loading…',
        saving: 'Saving…',
        creating: 'Creating…',
        installing: 'Installing…',
        importing: 'Importing…',
        copying: 'Copying…',
        save: 'Save',
        confirm: 'Confirm',
        typeToConfirmPrefix: 'Type',
        typeToConfirmSuffix: 'to confirm',
        cancel: 'Cancel',
        close: 'Close',
        copy: 'Copy',
        copied: 'Copied',
        retry: 'Retry',
        done: 'Done',
        continue: 'Continue',
        unknown: 'Unknown',
        dismiss: 'Dismiss',
        moreActions: 'More actions',
        breadcrumb: 'Breadcrumb',
        liveStatus: 'Live status · click to refresh now',
        sandboxStatusAria:
            'Sandbox status: {{status}}. Updates live; activate to refresh now.'
    },
    errors: {
        appCrash: {
            title: 'Something went wrong',
            body: 'This page hit an unexpected error. Reloading usually fixes it.',
            reload: 'Reload page'
        },
        api: {
            unauthorized: 'You are not signed in.',
            forbidden: 'You do not have permission to perform this action.',
            not_found: 'The requested resource was not found.',
            bad_request: 'The request was invalid.',
            internal_error:
                'Something went wrong on our end. Please try again.',
            CONCURRENT_ACTIVE_LIMIT_REACHED:
                'You have reached your concurrent active sandbox limit. Stop another sandbox or upgrade your plan.',
            WHOLESALE_CAPACITY_REACHED:
                'Platform capacity reached — please try again shortly.',
            ACTIVE_HOURS_QUOTA_REACHED:
                "You've used all included sandbox active hours for this billing period. Upgrade your plan to keep going.",
            STORAGE_LIMIT_REACHED:
                'You have reached your sandbox storage limit. Free up space or upgrade your plan.',
            RUNTIME_LIMIT_REACHED:
                'You have reached the number of sandboxes your plan allows. Delete one you no longer need, or upgrade your plan.',
            ALWAYS_ONLINE_AGENT_LIMIT_REACHED:
                'You have reached the number of always-online agents your plan allows. Remove one, or upgrade your plan.',
            ALWAYS_ONLINE_LIMIT_REACHED:
                'You have reached the number of always-online computers your plan allows. Remove one, or upgrade your plan.',
            CHANNEL_LIMIT_REACHED:
                'You have reached the number of channels your plan allows. Disconnect one, or upgrade your plan.',
            AUTOMATION_LIMIT_REACHED:
                'You have reached the number of automations your plan allows. Delete one, or upgrade your plan.',
            AUTOMATION_RUN_QUOTA_REACHED:
                "You've used all the automation runs included in your plan for this billing period. Upgrade your plan to keep them running.",
            API_REQUEST_QUOTA_REACHED:
                "You've used all the API requests included in your plan for this billing period. Upgrade your plan to keep going."
        },
        agentName: {
            empty: 'Agent name is required.',
            tooLong: 'Agent name must be {{max}} characters or fewer.',
            controlCharacter: 'Agent name cannot contain control characters.',
            invalidStart:
                'Agent name must start with a letter, number, or emoji.',
            invalidCharacter:
                'Agent name can contain letters, numbers, emoji, spaces, underscore, dash, and dot.'
        }
    },
    web: {
        tags: {
            risk: {
                low: 'Low risk',
                medium: 'Medium risk',
                high: 'High risk'
            },
            status: {
                running: 'Running',
                active: 'Active',
                streaming: 'Streaming',
                starting: 'Starting',
                provisioning: 'Provisioning',
                ready: 'Ready',
                ok: 'OK',
                online: 'Online',
                enabled: 'Enabled',
                succeeded: 'Succeeded',
                sent: 'Sent',
                completed: 'Completed',
                connected: 'Connected',
                healthy: 'Healthy',
                pending: 'Pending',
                queued: 'Queued',
                paused: 'Paused',
                warning: 'Warning',
                degraded: 'Degraded',
                failed: 'Failed',
                error: 'Error',
                blocked: 'Blocked',
                denied: 'Denied',
                warm: 'Warm',
                cold: 'Cold',
                idle: 'Idle',
                disabled: 'Disabled',
                offline: 'Offline',
                stopped: 'Stopped',
                archived: 'Archived'
            }
        },
        connectionProviders: {
            github: 'GitHub',
            cloudflare: 'Cloudflare',
            composio: 'Composio'
        },
        frameworks: {
            claudeCode: 'Claude Code',
            codex: 'Codex',
            geminiCli: 'Gemini CLI',
            openclaw: 'OpenClaw',
            hermes: 'Hermes Agent',
            narraNexus: 'NarraNexus',
            dify: 'Dify',
            langflow: 'Langflow',
            a2a: 'A2A'
        },
        agents: {
            detail: {
                a2a: {
                    a2aOffEnable: 'A2A off — enable',
                    acceptsCalls: 'this agent accepts A2A calls',
                    activity: 'Activity',
                    addCaller: 'Add caller',
                    addTarget: 'Add target',
                    agent: 'Agent',
                    agentCardUrl: 'Agent Card URL',
                    allDirections: 'All directions',
                    anyState: 'Any state',
                    authorizedAt: 'authorized {{date}}',
                    caller: 'caller',
                    callers: 'callers',
                    descriptionPrefix:
                        'Expose this agent over the A2A protocol so authorized peers and the',
                    descriptionSuffix: 'CLI can discover and call it.',
                    disableAction: 'Disable',
                    disableDescription:
                        'This agent will stop accepting A2A calls and disappear from peers’ mf a2a peers. Existing grants are kept and resume when you re-enable.',
                    disableTitle: 'Disable A2A',
                    enableAction: 'Enable A2A',
                    enableTargetPrefix: 'Turn on A2A for',
                    enableTargetSuffix:
                        'so this agent can reach it? The target will start accepting A2A calls.',
                    enableTargetTitle: 'Enable A2A on target',
                    enableTargetTooltip:
                        'Enable A2A on {{target}} so this agent can reach it',
                    enabledAt: 'enabled {{date}}',
                    expiresAt: ' · expires {{date}}',
                    external: 'External',
                    externalClient: 'the external client',
                    filterDirection: 'Filter by direction',
                    filterState: 'Filter by state',
                    fromPrefix: '← from ',
                    grantedAt: 'granted {{date}}',
                    inactiveNote:
                        'A2A is off, so these grants are inactive. Enable A2A above and callers can reach this agent.',
                    inboundTitle: 'Inbound · who can call this agent',
                    lastCallAgo: 'last call {{elapsed}} ago',
                    lastUsedAt: ' · last used {{date}}',
                    loadMore: 'Load more',
                    noCallerOptions:
                        'No eligible agents. Only sprites, daemon, and Kubernetes agents can act as callers, and ones you’ve already granted don’t appear here. You can still add an external client.',
                    noCallers:
                        'No callers yet. Add an agent peer or an external client to let it call this agent.',
                    noCalls: 'No A2A calls yet.',
                    noFilteredCalls: 'No A2A calls match these filters.',
                    noIdentityPrefix: 'This agent runs on the',
                    noIdentitySuffix:
                        'runtime, which has no runtime identity, so it can’t call other agents over A2A. Sprites, daemon, and Kubernetes agents can.',
                    noTargetOptions:
                        'No eligible targets — your other agents that aren’t already authorized appear here.',
                    noTargets:
                        'Not authorized to call any agents yet. Add a target to let this agent delegate over A2A.',
                    notAcceptingCalls: 'this agent does not accept A2A calls',
                    notExposed: 'Not exposed',
                    openChat: '· open chat',
                    outboundTitle: 'Outbound · agents this agent calls',
                    reachable: 'reachable',
                    revokeAccess: 'Revoke access',
                    revokeAction: 'Revoke',
                    revokeAuthorizationPrefix: 'Stop this agent from calling',
                    revokeAuthorizationTitle: 'Revoke authorization',
                    revokeGrantPrefix: 'Revoke access for',
                    revokeGrantSuffix: '? It can no longer call this agent.',
                    revokeGrantTitle: 'Revoke grant',
                    rpcEndpoint: 'RPC endpoint',
                    serving: 'Serving over A2A',
                    target: 'target',
                    targets: 'targets',
                    title: 'A2A interoperability',
                    toPrefix: '→ to ',
                    tokens: '· {{tokens}} tok'
                },
                actions: 'Actions',
                agentId: 'Agent ID',
                channels: {
                    description:
                        'Connect this agent to messaging platforms. Manage channels in',
                    emptyAction: 'Manage channels',
                    emptyBody:
                        'Connect this agent to a messaging platform to send and receive messages.',
                    emptyTitle: 'No channels yet.',
                    settingsLink: 'Settings → Channels',
                    status: {
                        active: 'Active',
                        draft: 'Draft',
                        error: 'Error',
                        paused: 'Paused'
                    },
                    title: 'Channels'
                },
                connections: {
                    cloudflareAria: 'Cloudflare connection',
                    composioAria: 'Composio connection',
                    description:
                        'Link a GitHub / Cloudflare account so this agent’s git, gh, wrangler and cloudflared authenticate automatically, or attach a Composio Connect key for tool access. Manage accounts in',
                    githubAria: 'GitHub connection',
                    none: 'None',
                    settingsLink: 'Settings → Connections',
                    title: 'Connections',
                    unavailableFramework:
                        '{{framework}} agents don’t use account connections — they apply to coding agents like Claude Code, Codex and Gemini CLI.',
                    unavailableRuntime:
                        'Connections are available on sandbox and self-owned computer runtimes.'
                },
                contextDoc: {
                    currentVersion: 'Current version',
                    descriptionPrefix: 'A managed',
                    descriptionSuffix:
                        'in the agent’s workspace telling it which connections it has and how to use them, referenced from CLAUDE.md / AGENTS.md / GEMINI.md.',
                    generated: 'Generated',
                    install: 'Install',
                    installedVersion: 'Installed version',
                    notAvailable: 'Not available for this agent.',
                    notInstalled: 'Not installed',
                    recheck: 'Re-check',
                    startAgentHint:
                        'Start the agent to install or update its context file.',
                    title: 'Platform context',
                    unavailableFramework:
                        '{{framework}} has no instruction file for a managed context doc — it is available for coding agents like Claude Code, Codex and Gemini CLI.',
                    unavailableRuntime:
                        'The context doc is available on sandbox and self-owned computer runtimes.',
                    upToDate: 'Installed · up to date',
                    update: 'Update',
                    updateAvailable: 'Installed · update available',
                    working: 'Working…'
                },
                copyAgentId: 'Copy agent ID',
                copyWorkspacePath: 'Copy workspace path',
                created: 'Created',
                dashboard: {
                    controlUi: 'Control UI',
                    controlUiDescription:
                        'Expose the OpenClaw control UI for this agent. Toggling briefly restarts the gateway.',
                    dashboard: 'Dashboard',
                    dashboardDescription:
                        'Expose the Hermes dashboard for this agent. First enable builds the web UI (about a minute); toggling briefly restarts the gateway.',
                    openDashboard: 'Open Dashboard ↗',
                    openUi: 'Open UI ↗'
                },
                delete: {
                    agentAction: 'Delete agent',
                    button: 'Delete',
                    confirmNamed:
                        'Permanently delete "{{name}}"? Its runtime resources and private state will be removed. This cannot be undone.',
                    confirmNamedSandbox:
                        'Permanently delete "{{name}}" and its private agent state? If this leaves its sandbox empty, the sandbox VM is kept and continues to count toward your quota until you reuse or delete it. This cannot be undone.',
                    deleting: 'Deleting…',
                    title: 'Delete agent'
                },
                edit: 'Edit',
                endpoint: 'Endpoint',
                environment: {
                    pendingTitle: 'Environment changes waiting for restart',
                    pendingDetail:
                        'Saved, but the running {{framework}} process still has the old values.',
                    pendingTag: 'pending',
                    pendingTooltip:
                        'Saved. Takes effect when the agent restarts.',
                    descriptionPrefix: 'In',
                    descriptionSuffix:
                        'format. These are visible to anyone using this environment — don’t add secrets or credentials.',
                    empty: 'No environment variables set.',
                    emptyValue: '(empty)',
                    lineError: 'Line {{line}}: {{reason}}',
                    reserved: 'reserved',
                    reservedTooltip:
                        'Reserved platform/framework name — not applied',
                    restartNow: 'Restart now',
                    serviceRestartHint:
                        '{{framework}} runs as a service — changes take effect after a restart.',
                    placeholderName: 'Your Name',
                    placeholderMultilineComment: '# Multiline values - wrap in quotes',
                    title: 'Environment variables',
                    unavailableOpenclaw:
                        'OpenClaw on a self-owned computer has no per-turn environment channel yet — set variables in that machine’s own environment instead.',
                    unavailableRuntime:
                        'Environment variables are available on sandbox and self-owned computer runtimes.'
                },
                error: 'Error',
                files: {
                    title: 'Files'
                },
                framework: {
                    changeTitle: 'Change framework version',
                    changeVersion: 'change version',
                    changeVersionEllipsis: 'Change version…',
                    chooseVersion:
                        'Choose a {{framework}} version to install. Upgrades run in the sandbox and may take up to a minute.',
                    latest: 'latest {{version}}',
                    latestAvailable: '↑ latest {{version}} available',
                    notDetected: 'not detected',
                    refreshVersion: 'Refresh version',
                    upgrade: 'Upgrade',
                    upgradeTitle: 'Upgrade framework',
                    upgrading: 'Upgrading…',
                    upgradingStep: 'Upgrading… {{step}}',
                    versionBlocked:
                        'This {{framework}} version has a known defect',
                    versionLabel: 'Version'
                },
                lastActive: 'Last active',
                lastMessage: 'Last message',
                mcp: {
                    alreadySynced: 'Already in sync with the runtime.',
                    deliveryDelivered: 'Delivered to this computer.',
                    deliveryFailed: 'Delivery failed',
                    deliverySkipped: 'Skipped',
                    pushToRuntime: 'Push to computer',
                    pushing: 'Pushing…',
                    applyHint:
                        'Changes apply on the agent’s next turn. This tab shows the Manyfold-managed config — edits made directly to the runtime’s config files appear only after a sync from runtime.',
                    description:
                        'Configure the Model Context Protocol servers available to this {{framework}} agent, in its native {{format}} syntax.',
                    empty: 'No MCP servers configured.',
                    imported: 'Imported {{count}} scope(s) from the runtime.',
                    jsonHelp:
                        'A JSON object mapping server name → config. Leave empty to remove all servers in this scope.',
                    managedComposio: 'managed · Composio connection',
                    managedHelp:
                        'Managed by a linked Composio connection and injected automatically (read-only; leave it out of the text above):',
                    multiScopeHint:
                        'Each scope maps to a different config file the CLI reads.',
                    sandboxOnly:
                        'MCP servers can be configured for agents on sandbox and self-owned computer runtimes.',
                    scopeTitle: '{{scope}} scope',
                    servers: 'Servers',
                    syncFromRuntime: 'Sync from runtime',
                    syncing: 'Syncing…',
                    title: 'MCP tools',
                    tomlHelp:
                        'One or more [mcp_servers.<name>] tables. Leave empty to remove all servers.',
                    unsupported:
                        '{{framework}} does not read MCP server config, so there is nothing to configure here.'
                },
                modelProvider: {
                    apiKey: 'API key',
                    baseUrl: 'Base URL',
                    configureMapping: 'Configure model mapping',
                    configureProvider: 'Configure provider',
                    label: 'Model',
                    localModels: '{{count}} local models',
                    manyfoldConfig: 'Manyfold config',
                    metadataUnavailable: 'Model provider metadata unavailable.',
                    needsAttention: 'Model configuration needs attention.',
                    noPlatformProvider:
                        'No Manyfold platform provider configured.',
                    provider: 'Provider',
                    runtimeLocal: 'Runtime local',
                    runtimeLocalConfig: 'Runtime local config',
                    savedProvider: 'Saved provider',
                    source: 'Model source',
                    supportedCount: '{{count}} supported',
                    supportedModels: 'Supported models',
                    testRequired: 'Test required',
                    title: 'Model provider',
                    unavailable: 'Unavailable',
                    unavailableExternal:
                        'External agents run on their own provider, so the model is chosen where that agent is hosted rather than here.'
                },
                notFound: 'Agent not found.',
                openNativeFailed: 'Failed to open NarraNexus',
                openNativeUi: 'Open Native UI ↗',
                permissions: {
                    addAction: 'Add permission',
                    description:
                        'What this agent may do on its own resources. The agent acts with its own identity — granting a capability here takes effect on its next request, no token to copy.',
                    emptyPrefix:
                        'No capabilities granted yet. The agent can only act once you add a permission, or it requests one with',
                    lastUpdated: 'Last updated {{date}}',
                    loadFailed: 'Failed to load permissions.',
                    removeAction: 'Remove',
                    removePrefix: 'The agent will lose',
                    removeScope: 'Remove {{scope}}',
                    removeSuffix: 'on its next request.',
                    removeTitle: 'Remove capability',
                    title: 'Permissions'
                },
                refresh: 'Refresh',
                runtime: 'Runtime',
                saving: 'Saving…',
                skills: {
                    description:
                        'Agent skills installed for this {{framework}} agent. Enable, update, or remove skills — changes apply on the next turn.',
                    needsRuntime:
                        'Skills need an attached runtime. Attach this agent to a runtime to install skills.',
                    title: 'Skills',
                    unsupported:
                        'Skills are not supported for {{framework}} agents. They are available for frameworks that discover workspace skills, like Claude Code and Codex.'
                },
                status: 'Status',
                storage: {
                    restoreSnapshotNote:
                        'The current workspace is backed up first, so this can be undone.',
                    archive: 'Archive',
                    backupsTitle: 'Backups',
                    createBackup: 'Create backup',
                    deleteAction: 'Delete',
                    deleteConfirm: 'Delete backup from {{date}}?',
                    deleteTitle: 'Delete backup',
                    manage: 'Manage →',
                    measured: 'Measured {{date}}',
                    measuredInline: ' · measured {{date}}',
                    noBackups: 'No workspace backups yet.',
                    notMeasured: 'Storage usage has not been measured yet.',
                    notMeasuredInline: ' · not measured yet',
                    restoreAction: 'Restore',
                    restoreConfirm:
                        'Restore backup from {{date}}? Current workspace files will be replaced.',
                    restoreFailed: 'The restore did not finish.',
                    restoreSnapshotFailed:
                        'Backing up the current workspace failed, so the restore was not started — your workspace is untouched. Try again once the backup succeeds.',
                    restoreSnapshotTimeout:
                        'Backing up the current workspace is taking longer than expected, so the restore was not started — your workspace is untouched. Wait for that backup to finish, then restore again.',
                    restoreStatus: 'Restore {{status}}. Started {{date}}.',
                    restoreTitle: 'Restore backup',
                    unavailableExternal:
                        'External agents have no workspace on Manyfold, so there is nothing to back up here.',
                    starting: 'Starting...',
                    title: 'Storage',
                    total: 'Total'
                },
                updated: 'Updated',
                updating: 'Updating…',
                workspace: 'Workspace',
                yourMachine: 'your machine'
            }
        },
        automations: {
            title: 'Automations',
            newAction: 'New automation',
            current: 'Current',
            paused: 'Paused',
            noneCurrent: 'No current automations.',
            titlePlaceholder: 'Automation title',
            promptPlaceholder: 'What should the agent do on each run?',
            defaultModel: 'Default',
            chooseSupportedModel: 'Choose a supported model',
            cancel: 'Cancel',
            create: 'Create',
            deleteTitle: 'Delete automation',
            deleteConfirm: 'Delete "{{title}}"? This cannot be undone.',
            deleteAction: 'Delete',
            pause: 'Pause',
            resume: 'Resume',
            runNow: 'Run now',
            saveChanges: 'Save changes',
            active: 'Active',
            nextRun: 'Next run',
            lastRan: 'Last ran',
            details: 'Details',
            agent: 'Agent',
            repeats: 'Repeats',
            model: 'Model',
            deliverResults: 'Deliver results',
            channel: 'Channel',
            destination: 'Destination',
            sendTo: 'Send to',
            chatGroup: 'Chat / group',
            userDm: 'User (DM)',
            chatId: 'Chat id',
            userId: 'User id',
            providerChatId: 'provider chat id',
            providerUserId: 'provider user id',
            loadingConversations: 'Loading conversations…',
            chooseConversation: 'Choose a conversation…',
            customChatUserId: 'Custom chat/user id…',
            savedConversationInactive: 'Saved conversation — inactive',
            inactive: 'inactive',
            noConversationsCustom:
                'No conversations on this channel yet — message the bot there first, or use a custom id.',
            noConversations:
                'No conversations on this channel yet. Send the bot a message (or @mention it) there first, then pick it here.',
            resultNotice:
                'The run result posts into the chosen conversation when it finishes; a reply of [SILENT] skips the notification. Rename a conversation under Settings → Channels to label it here.',
            previousRuns: 'Previous runs',
            noRuns: 'No runs yet.',
            running: 'Running',
            failed: 'Failed',
            completed: 'Completed',
            schedule: 'Schedule',
            schedulePreset: 'Schedule preset',
            repeatDay: 'Repeat day',
            scheduleTime: 'Schedule time',
            customRrule: 'Custom RRULE',
            hourly: 'Hourly',
            daily: 'Daily',
            weekdays: 'Weekdays',
            weekly: 'Weekly',
            custom: 'Custom',
            weekdaysAt: 'Weekdays at {{time}}',
            weeklyOn: 'Weekly on {{day}} at {{time}}',
            dailyAt: 'Daily at {{time}}',
            notScheduled: 'Not scheduled',
            monday: 'Monday',
            tuesday: 'Tuesday',
            wednesday: 'Wednesday',
            thursday: 'Thursday',
            friday: 'Friday',
            saturday: 'Saturday',
            sunday: 'Sunday',
            loadingModels: 'Loading models…',
            emptyLead:
                'Automations run your agent on a schedule: a prompt, a time, and optionally a channel to deliver the result to.',
            templatesHint:
                'Templates prefill the prompt and schedule, and everything stays editable.',
            useTemplate: 'Use',
            templateBriefingTitle: 'Morning briefing',
            templateBriefingPrompt:
                'Check my email and calendar for today. Summarize anything that needs a reply, list meetings with prep notes, and flag deadlines landing this week.',
            templateReportTitle: 'Weekly report',
            templateReportPrompt:
                'Compile what shipped this week into a short summary, grouped by project, and call out anything still blocked.',
            templateWatchTitle: 'Site watch',
            templateWatchPrompt:
                'Check whether the site responds and the main pages still render. Report only when something looks broken.',
            needAgent: 'Automations run on an agent, so create one first.',
            needAgentAction: 'Create an agent',
            justNow: 'Just now',
            minutesAgo: '{{count}}m ago',
            hoursAgo: '{{count}}h ago',
            daysAgo: '{{count}}d ago',
            failedAgo: 'Failed {{when}}',
            todayAt: 'today, {{time}}',
            tomorrowAt: 'tomorrow, {{time}}',
            nextShort: 'next {{when}}',
            workbenchOnly: 'Workbench only',
            recapDelivered:
                'Runs {{schedule}} ({{timezone}}) on {{agent}}, and delivers the result to {{destination}}.',
            recapWorkbench:
                'Runs {{schedule}} ({{timezone}}) on {{agent}}, and the result stays in this workspace.',
            noChannelForAgent:
                '{{agent}} is not connected to a channel yet, so results stay in this workspace. Create the automation now and connect a channel later.',
            connectChannel: 'Connect a channel',
            unsavedChanges: 'Unsaved changes',
            discard: 'Discard',
            deliverNotice: 'Each run posts its result here when it finishes.',
            triggerManual: 'manual',
            delivered: 'delivered',
            deliverySilent: 'silent',
            deliveryFailed: 'delivery failed',
            retry: 'Retry',
            viewAllRuns: 'View all runs',
            durationSeconds: '{{seconds}}s',
            durationMinutes: '{{minutes}}m {{seconds}}s',
            previewHourly: 'Every hour at :{{minute}}',
            previewEveryNHours: 'Every {{count}} hours at :{{minute}}',
            previewDaily: 'Every day at {{time}}',
            previewEveryNDays: 'Every {{count}} days at {{time}}',
            previewWeekdays: 'Every weekday at {{time}}',
            previewWeekly: 'Every {{days}} at {{time}}',
            previewEveryNWeeks: 'Every {{count}} weeks on {{days}} at {{time}}',
            previewMonthly: 'Every month on day {{day}} at {{time}}',
            rruleMissingFreq:
                'This rule needs FREQ, for example FREQ=WEEKLY;BYDAY=MO;BYHOUR=9.',
            rruleUnknownFreq:
                'FREQ={{value}} is not supported here. Use HOURLY, DAILY, WEEKLY or MONTHLY.',
            rruleUnknownWeekday:
                'BYDAY={{value}} is not a weekday. Use MO, TU, WE, TH, FR, SA or SU.',
            rruleBadHour: 'BYHOUR takes a number from 0 to 23.',
            rruleBadMinute: 'BYMINUTE takes a number from 0 to 59.',
            rruleBadInterval: 'INTERVAL takes a whole number of 1 or more.',
            rruleBadMonthDay: 'BYMONTHDAY takes a number from 1 to 31.',
            fieldTitle: 'Title',
            fieldPrompt: 'Prompt',
            scope: {
                dm: 'DM',
                channel: 'Channel',
                thread: 'Thread',
                'channel-user': 'Channel (per-user)',
                conversation: 'Conversation'
            }
        },
        controlRow: {
            open: 'Open ↗',
            enabling: 'Enabling…',
            disabling: 'Disabling…'
        },
        workbenchSelect: {
            placeholder: 'Select…'
        },
        runtimeDetails: {
            copy: 'Copy',
            copied: 'Copied',
            versionPending: 'version pending',
            primary: 'Primary',
            synced: 'synced {{time}}',
            secondsAgo: '{{count}}s ago',
            minutesAgo: '{{count}}m ago',
            hoursAgo: '{{count}}h ago',
            daysAgo: '{{count}}d ago',
            ready: 'Ready',
            starting: 'Starting',
            stopped: 'Stopped',
            unknown: 'Unknown',
            pending: 'Pending',
            failed: 'Failed',
            online: 'Online',
            offline: 'Offline',
            checked: 'checked {{time}}',
            failedToOpenControlUi: 'Failed to open control UI',
            failedToOpenDashboard: 'Failed to open dashboard',
            deleteTitle: 'Delete runtime',
            deleteConfirm:
                'Delete runtime "{{name}}"? Its agents and runtime resources will be torn down.',
            deleteAction: 'Delete',
            refreshVersion: 'Refresh version',
            changeVersion: 'Change version',
            refresh: 'Refresh',
            actions: 'Runtime actions',
            rename: 'Rename',
            deleting: 'Deleting…',
            runtimeFailed: 'Runtime failed',
            upgradeAvailable: '{{framework}} v{{version}} is available',
            currentVersion:
                'This runtime is on v{{version}}. Upgrades run in the sandbox and take up to a minute.',
            upgradeNotice:
                'Upgrades run in the sandbox and take up to a minute.',
            upgrade: 'Upgrade',
            agents: 'Agents ({{count}})',
            controls: 'Controls',
            controlUi: 'Control UI',
            controlUiDescription:
                'Expose the OpenClaw control UI for this runtime. Toggling briefly restarts the gateway.',
            restarting: 'Restarting…',
            openUi: 'Open UI ↗',
            dashboard: 'Dashboard',
            dashboardDescription:
                'Expose the Hermes dashboard for this runtime. First enable builds the web UI (about a minute); toggling briefly restarts the gateway.',
            updating: 'Updating…',
            openDashboard: 'Open Dashboard ↗',
            keepAlive: 'Keep alive',
            keepAliveDescription:
                'Keeps this sandbox always running. Uses one of your concurrent active sandbox slots and accrues running time until turned off.',
            details: 'Details',
            primaryAgent: 'Primary agent',
            statefulSandbox: 'Stateful sandbox',
            cluster: 'Cluster',
            namespace: 'Namespace',
            ingress: 'Ingress',
            machine: 'Machine',
            endpoint: 'Endpoint',
            mountPath: 'Mount path',
            homeDir: 'Home dir',
            workspaceBase: 'Workspace base',
            cliVersion: 'CLI version',
            lastSeen: 'Last seen',
            service: 'Service',
            phase: 'Phase',
            started: 'Started',
            created: 'Created',
            upgradeFramework: 'Upgrade framework',
            changeFrameworkVersion: 'Change framework version',
            chooseVersion:
                'Choose a {{framework}} version to install. Upgrades run in the sandbox and may take up to a minute.',
            cancel: 'Cancel',
            upgrading: 'Upgrading…',
            version: 'Version',
            renameRuntime: 'Rename runtime',
            account: {
                title: 'Account',
                signedIn: 'Signed in',
                notSignedIn: 'Not signed in',
                expired: 'Sign-in expired',
                apiKey: 'API key',
                unknownStatus: 'Unknown',
                noIdentity: 'No account details',
                checkNow: 'Check now',
                sandboxAsleep: 'The sandbox is asleep. Checking its account wakes it and counts as running time.',
                daemonOffline: 'The machine is offline, so its sign-in cannot be checked.',
                daemonUpgradeRequired: 'Update the mf CLI on this machine to see its account and usage.',
                probeFailed: 'Could not check the account on this runtime.',
                usageStale: 'The saved sign-in has expired on the runtime. Usage shows again after the CLI next runs and refreshes it.',
                usageUnauthorized: 'The provider rejected the saved sign-in. Sign in again to see usage.',
                usageRateLimited: 'The provider is rate limiting usage checks. Try again in {{time}}.',
                usageNetwork: 'The runtime could not reach the provider to read usage.',
                usageUnexpected: 'The provider returned an unexpected usage response.',
                usageApiKey: 'An API-key sign-in has no subscription usage to show.',
                keychainUnread: 'On macOS the token lives in the Keychain, which the daemon does not read, so usage is not available here.',
                resetsIn: 'resets in {{time}}',
                windowFiveHour: 'Current session (5h)',
                windowSevenDay: 'Weekly (7d)',
                windowSevenDayOpus: 'Weekly · Opus',
                windowSevenDaySonnet: 'Weekly · Sonnet',
                windowGeminiPro: 'Gemini Pro',
                windowGeminiFlash: 'Gemini Flash',
                windowGeminiFlashLite: 'Gemini Flash-Lite',
                signIn: 'Sign in',
                signInBody: 'Sign in inside this terminal on the runtime, then close it to refresh the account.',
                signInHint: 'Open a shell on the runtime and run the sign-in there. Your subscription stays on that machine.'
            }
        },
        marketing: {
            toggleTheme: 'Toggle theme',
            menu: 'Menu',
            lightMode: 'Light mode',
            darkMode: 'Dark mode',
            beta: 'Beta',
            // Carries what the dropped globe icon used to say — the visible
            // label is only the two-letter code.
            language: 'Language',
            followX: 'Follow on X',
            // "Discord", not "our Discord": the invite opens the NetMind.AI
            // server, so promising a Manyfold one would misdescribe it.
            joinDiscord: 'Join Discord',
            sourceGithub: 'Source on GitHub'
        },
        cascade: {
            close: 'Close',
            groupBy: 'Group by'
        },
        seo: {
            signIn: 'Sign in',
            legal: '© 2026 Manyfold',
            privacy: 'Privacy',
            terms: 'Terms',
            socialImageAlt: 'Manyfold — AI agent workspace',
            notFoundTitle: 'Page not found · Manyfold',
            notFoundHeading: '404 — page not found',
            notFoundBody: 'The page you are looking for does not exist.',
            notFoundBack: 'Back to manyfold.ai'
        },
        seoPage: {
            home: {
                title: 'Manyfold — AI Agent Workspace for Coding Agents',
                description:
                    'Run Claude Code, Codex, Gemini CLI and more in one AI agent workspace: hosted sandboxes, persistent sessions, chat, files, terminal and team channels.',
                h1: 'Host your agents. Your work, multiplied.',
                lead: 'Manyfold is an AI agent workspace for coding agents. Create and run Claude Code, Codex, Gemini CLI, OpenClaw, Hermes and other agents from one place — with chat, files, terminal, resumable sessions, skills and team channels.',
                ctaTitle: 'Start with your first agent',
                ctaPrimary: 'Request access',
                ctaSecondary: 'Read the docs',
                docsLinksLabel: 'Learn more',
                docsGettingStarted: 'Getting started',
                docsWorkspace: 'Agent workspace',
                docsCreateAgent: 'Create an agent',
                docsChannels: 'Channels'
            }
        },
        cliUpgrade: {
            one: '1 machine needs a CLI upgrade',
            many: '{{count}} machines need a CLI upgrade'
        },
        backgroundTasks: {
            running: 'Running',
            finished: 'Finished',
            clear: 'Clear',
            empty: 'No background tasks.',
            loading: 'Loading…',
            noAgent: 'Open an agent to see its background tasks.',
            viewTranscript: 'View transcript',
            transcriptUnavailable: 'Transcript not available.',
            loadingTranscript: 'Loading transcript…',
            back: 'Back',
            type: 'A2A',
            tokens: '{{count}} tokens',
            direction: {
                inbound: 'Inbound',
                outbound: 'Outbound'
            },
            states: {
                submitted: 'Submitted',
                working: 'Working',
                'input-required': 'Input required',
                completed: 'Completed',
                canceled: 'Canceled',
                failed: 'Failed',
                rejected: 'Rejected',
                'auth-required': 'Auth required',
                unknown: 'Unknown'
            }
        },
        emptyState: {
            sandboxActivityTitle: 'No activity',
            sandboxActivityBody:
                'Nothing is running or scheduled, so the sandbox will pause on its own.',
            runtimesTitle: 'No runtimes yet',
            hostRuntimesBody:
                'Install a framework below and the daemon will detect it.',
            sandboxRuntimesBody: 'Provision a framework below to add one.',
            createRuntimeBody: 'Create a sandbox runtime to get started.',
            createRuntimeAction: 'Create runtime',
            runtimeNotFoundTitle: 'Runtime not found',
            runtimeNotFoundBody: 'It may have been removed.',
            runtimeAgentsTitle: 'No agents yet',
            runtimeAgentsBody: 'Agents created on this runtime appear here.',
            agentsTitle: 'No agents yet',
            agentsWorkspaceBody:
                'An agent works in its own sandbox — chat with it, give it skills, or put it on a schedule.',
            agentsCreateAction: 'Create agent',
            noMatches: 'No matches.',
            usageEventsTitle: 'No usage events yet',
            usageEventsBody: 'Once your agents run, activity shows up here.',
            usageRangeTitle: 'No usage in the last {{range}}',
            usageRangeBody:
                'Once your agents run, token and cost activity shows up here.',
            usageNoActivity: 'No activity in this range.',
            usageNoCostTitle: 'No cost data',
            usageNoCostBody: 'Try a different time range.',
            modelsTitle: 'No models discovered',
            modelsBody: 'Refresh models to query this provider again.',
            modelSearchTitle: 'No model matches “{{query}}”',
            modelSearchBody:
                'The list comes from this provider’s catalog. Clear the search, or refresh models to pick up newly published ones.',
            connectionsTitle: 'No connections yet',
            connectionsBody:
                'Link GitHub, Cloudflare or Composio so agents authenticate automatically.',
            channelsTitle: 'No channels yet',
            channelsBody: 'Bridge an agent into a chat platform.',
            channelDeliveriesEmpty: 'No recent deliveries.',
            creditHistoryTitle: 'No credit history',
            sandboxUsageTitle: 'No sandbox usage this period',
            agentNotFoundTitle: 'Agent not found',
            agentNotFoundBody:
                'It may have been deleted, or the link is out of date. Pick another agent from the sidebar.'
        },
        settingsMenu: {
            updates: 'Updates',
            personalAccount: 'Personal account',
            settings: 'Settings',
            usage: 'Usage',
            usageWindow5h: 'Last 5 hours',
            usageWindow7d: 'Last week',
            theme: 'Theme',
            language: 'Language',
            learnMore: 'Learn more',
            learnMoreMenu: 'Learn more links',
            docs: 'Docs',
            gettingStarted: 'Getting Started',
            installCli: 'Install CLI',
            telegramChannel: 'Telegram Channel',
            slackChannel: 'Slack Channel',
            larkChannel: 'Lark and Feishu Channel',
            discordChannel: 'Discord Channel',
            changelog: 'Changelog',
            status: 'Status',
            privacyPolicy: 'Privacy Policy',
            termsOfService: 'Terms of Service',
            logOut: 'Log out'
        },
        agentSettings: {
            timing: {
                immediate: 'Applies immediately',
                nextTurn: 'Next turn',
                nextRequest: 'Next request',
                restart: 'Restart required'
            },
            restart: {
                title: 'Restart agent?',
                description:
                    'Restarting {{name}} interrupts anything it is doing now and applies pending environment changes.',
                confirm: 'Restart',
                action: 'Restart…',
                working: 'Restarting…'
            },
            overview: {
                keepAliveOn: 'kept warm',
                details: 'Details',
                interfaces: 'Interfaces',
                framework: 'Framework',
                provider: 'Provider',
                cli: 'mf CLI',
                cliUpToDate: 'up to date',
                cliUpdate: '{{version}} available',
                access: 'Manyfold access',
                accessSkill: 'Manyfold CLI skill',
                accessSkillMeta:
                    'manyfold-cli-usage · managed · ships with new agents',
                accessInstalled: 'Installed',
                accessMissing: 'Not installed',
                accessInstalledBlurb:
                    'Lets this agent manage channels, automations, skills, files and backups for you through the mf CLI, within the permissions you grant it.',
                accessMissingBlurb:
                    'Want this agent to operate Manyfold for you? This skill teaches it to manage channels, automations, skills, files and backups through the mf CLI. New agents get it by default — add it back if it is missing.',
                channelCount: '{{count}} channels',
                channelErrors: '{{count}} error',
                channelsBroken: '{{name}} cannot authenticate',
                channelsBrokenMore: '+{{count}} more affected',
                fixInChannels: 'Fix in Channels',
                a2aOn: 'A2A on',
                a2aOff: 'A2A off',
                deleteBlurb:
                    'Deletes the workspace, channels and stored credentials. This cannot be undone.'
            },
            sections: {
                overview: 'Overview',
                model: 'Model',
                skills: 'Skills',
                mcp: 'MCP',
                context: 'Context',
                permissions: 'Permissions',
                connections: 'Connections',
                environment: 'Environment',
                storage: 'Storage & backups',
                channels: 'Channels',
                a2a: 'A2A'
            }
        },
        shell: {
            newChat: 'New chat',
            newAgent: 'New agent',
            customize: 'Customize',
            automations: 'Automations',
            menu: 'Menu',
            pinned: 'Pinned',
            pinnedChats: 'Pinned chats',
            agents: 'Agents',
            noAgents: 'No agents yet. Create one to start working.',
            readOnly: 'Read only',
            slotsTitle: '{{used}}/{{max}} concurrent sandboxes running',
            slotsTitleWithHours:
                '{{used}}/{{max}} concurrent sandboxes running · {{hours}} active hours left',
            slotsHint: 'Concurrent sandboxes · click for details',
            slotsFull:
                'Concurrent limit reached — stop a running agent to free a slot (~{{sec}}s to release)',
            slotActive: 'Active',
            slotReleasing: 'Releasing…',
            slotsPanelTitle: 'Concurrent sandboxes',
            slotsPlan: '{{plan}} plan',
            slotsNone: 'No running sandboxes right now.',
            slotNoAgents: 'No agents',
            keepAliveTag: 'Keep-alive',
            keepAliveDescription: 'Stays online and keeps using active hours.',
            keepAliveUsage: 'Kept online — {{duration}} used this period.',
            keepAliveHint: 'Turn off to let it sleep when idle.',
            keepAliveTurnOff: 'Turn off',
            keepAliveViewRuntime: 'View runtime',
            keepAliveTurningOff: 'Turning off…',
            activeHoursTitle: 'Active hours',
            activeHoursUnlimited: 'Unlimited',
            activeHoursUsed: '{{used}} / {{limit}}',
            activeHoursRemaining: '{{remaining}} left',
            activeHoursResets: 'Resets {{date}}',
            activeHoursLowWarning:
                'Active hours are running low. Sandboxes pause when they run out.',
            activeHoursExhaustedWarning:
                'Active hours are used up for this period. Running sandboxes have been paused and can’t wake until it resets.',
            activeHoursUpgrade: 'Upgrade plan',
            allChatsPinned: 'All chats are pinned above.',
            noChatsYet: 'No chats yet',
            noChatsAvailable: 'No chats available for this agent.',
            loadingChats: 'Loading chats...',
            retryLoadingChats: 'Retry loading chats',
            showMoreChats: 'Show {{count}} more',
            showFewerChats: 'Show fewer',
            agentSettings: 'Agent settings',
            rename: 'Rename',
            openDashboard: 'Open dashboard',
            openDashboardPopupBlocked:
                'Popup blocked. Allow popups for this site, then try again.',
            openDashboardFailedTitle: 'Failed to open dashboard',
            runtime: 'Runtime',
            modelProvider: 'Model provider',
            defaultModelTitle: 'Default model',
            defaultModelSubtitle:
                'Used when this agent runs · {{supported}}/{{total}} available',
            supportedModelsNeedsTest:
                'Needs provider test before support can be shown',
            supportedModelsTestHint:
                'Test the selected provider to see which {{framework}} models it supports.',
            testProvider: 'Test provider',
            testingProvider: 'Testing...',
            currentDefaultModel: 'Current default',
            defaultModelUpdated: 'Default model updated.',
            modelNeedsTest: 'Needs test',
            modelUnsupported: 'Unsupported',
            expandSidebar: 'Expand sidebar',
            collapseSidebar: 'Collapse sidebar',
            closeSidebar: 'Close sidebar',
            resizeSidebar: 'Drag to resize · double-click to reset',
            openPinnedChats: 'Open pinned chats',
            openSessionsForAgent: 'Open sessions for {{name}}',
            pinChat: 'Pin {{title}}',
            unpinChat: 'Unpin {{title}}',
            deleteChat: 'Delete {{title}}',
            confirmDelete: 'Confirm delete',
            untitledChat: 'Untitled chat',
            openAgent: 'Open {{name}}',
            expandAgent: 'Expand {{name}}',
            collapseAgent: 'Collapse {{name}}',
            newChatForAgent: 'New chat for {{name}}',
            sessionMenu: 'Chat options',
            sessionMenuRename: 'Rename session title',
            sessionMenuRenameChannel: 'Rename channel display',
            sessionMenuShare: 'Share',
            sessionMenuPin: 'Pin',
            sessionMenuUnpin: 'Unpin',
            sessionMenuDelete: 'Delete',
            agentsView: {
                button: 'View options',
                runtimeHost: 'Runtime host',
                framework: 'Framework',
                lastActivity: 'Last activity',
                groupBy: 'Group by',
                sortBy: 'Sort by',
                clearFilters: 'Clear filters',
                all: 'All',
                selectedCount: '{{count}} selected',
                groupNone: 'None',
                groupDate: 'Date',
                sortCreated: 'Created time',
                sortRecency: 'Recency',
                activity1d: 'Last 24 hours',
                activity3d: 'Last 3 days',
                activity7d: 'Last 7 days',
                activity30d: 'Last 30 days',
                activityAll: 'Any time',
                emptyFiltered: 'No agents match these filters.',
                date: {
                    today: 'Today',
                    yesterday: 'Yesterday',
                    week: 'Previous 7 days',
                    month: 'Previous 30 days',
                    older: 'Older'
                }
            }
        },
        // Browser tab titles. Short by design: a tab truncates fast, so the
        // distinctive word has to come first. Pages whose navigation link
        // already has a label reuse that key instead of repeating the wording.
        pageTitle: {
            signIn: 'Sign in',
            cliLogin: 'Terminal sign-in',
            connectAgent: 'Connect agent',
            grantPermission: 'Grant permission',
            invite: 'Invitation',
            workspace: 'Workspace',
            agent: 'Agent',
            chat: 'Chat',
            sharedChat: 'Shared chat',
            sharedSkill: 'Shared skill',
            skill: 'Skill',
            skillEditor: 'Edit skill',
            mcpServer: 'MCP server',
            connection: 'Connection'
        },
        settingsLayout: {
            backToChat: 'Back to chat',
            backToChatWith: 'Back to chat with {{name}}',
            backToWorkspace: 'Back to workspace',
            general: 'General',
            runtimes: 'Runtimes',
            cloudComputers: 'Cloud computers',
            localDaemons: 'Self-owned computers',
            apiTokens: 'API tokens',
            planAndBilling: 'Plan & billing',
            usage: 'Usage',
            providers: 'Model providers',
            account: 'Account',
            externalAgentProviders: 'External agents',
            channels: 'Channels',
            kicker: 'Workspace settings',
            body: 'Runtime controls, usage reporting, and provider management live here in a dedicated workspace surface.'
        },
        general: {
            title: 'General',
            subtitle:
                'Set workspace language, color mode, and interface scale for this device.',
            languageTitle: 'Language',
            languageBody:
                'Choose the display language for navigation, settings, and workspace chrome.',
            themeTitle: 'Appearance',
            themeBody: 'Switch between light and dark mode.',
            themeLight: 'Light',
            themeDark: 'Dark',
            fontSizeTitle: 'Font size',
            fontSizeBody: 'Adjust interface text size across the web app.',
            fontSizeCompact: 'Compact',
            fontSizeDefault: 'Default',
            fontSizeLarge: 'Large',
            fontSizeCompactHint: 'Smaller text for dense workspaces',
            fontSizeDefaultHint: 'Balanced interface scale',
            fontSizeLargeHint: 'Larger text for readability'
        },
        planAndBilling: {
            title: 'Plan & billing',
            subtitle:
                'Your plan, quota usage, and inference credit, in one place.',
            upgradeCta: 'Upgrade plan',
            manageBillingCta: 'Manage billing',
            planTitle: 'Current plan',
            planPriceMonthly: '{{price}} / month',
            planPriceFree: 'Free',
            planHoursIncluded: '{{hours}} active hours / month included',
            planHoursUnlimited: 'Unlimited active hours',
            quotaAgents: 'Sandbox VMs provisioned',
            quotaConcurrent: 'Concurrent active sandboxes',
            quotaStorage: 'Sandbox storage',
            quotaActiveHours: 'Sandbox active hours this period',
            quotaAlwaysOnlineRuntimes: 'Always-online runtimes',
            quotaAlwaysOnlineAgents: 'Always-online agents',
            quotaChannels: 'Channels',
            quotaAutomations: 'Automations',
            quotaAutomationRuns: 'Automation runs this period',
            quotaApiRequests: 'API requests this period',
            quotaUnlimited: 'Unlimited',
            quotaRemaining: '{{remaining}} left',
            quotaOverBy: '{{amount}} over',
            quotaNearLimit: 'Near limit',
            quotaOverLimit: 'Over limit',
            usagePeriodRange:
                'Billing period: {{start}} – {{end}} (UTC), resets {{resetDate}}',
            sectionUsageBasedTitle: 'Usage-based runtimes',
            sectionUsageBasedBody:
                'Stateful sandbox agents that spin up on demand and bill by active hour.',
            sectionAlwaysOnlineTitle: 'Always-online runtimes',
            sectionAlwaysOnlineBody:
                'Daemons on your own machines plus rented platform containers — both stay running 24/7.',
            sectionAccountTitle: 'Account limits',
            sectionAccountBody:
                'Quotas that apply across your whole account, independent of which runtime an agent uses.',
            retentionLabel: 'Message history retention',
            retentionValueDays: '{{days}} days',
            retentionValueUnlimited: 'Unlimited',
            containersTitle: 'Cloud computer',
            containersBody:
                'Platform-rented cloud computers count toward your always-online runtime quota and are billed per month.',
            containersCount: '{{count}} active',
            containersManage: 'Manage cloud computers',
            containersBuy: 'Rent a cloud computer',
            daemonsTitle: 'Self-owned computer',
            daemonsBody:
                'Computers you run yourself, registered with a daemon token. Each computer counts toward your always-online runtime quota.',
            daemonsCount: '{{count}} registered',
            daemonsManage: 'Manage self-owned computers',
            daemonsRegister: 'Register a new computer',
            creditTitle: 'Managed inference credit',
            creditBody:
                'Credit, concurrency, and spend on the Manyfold managed account.',
            creditBalance: 'Balance',
            creditConcurrency: 'Concurrency',
            creditLastSynced: 'Last synced {{timestamp}}',
            creditNeverSynced: 'Never synced',
            creditDisabled:
                'Managed inference is not enabled for your account.',
            creditTodaySpend: 'Today',
            creditWeekSpend: 'Last 7 days',
            creditMonthSpend: 'This month',
            creditRedeemCta: 'Redeem credit code',
            creditTopupCta: 'Top up {{amount}}',
            creditHistoryCta: 'Credit history',
            costTitle: 'Recent inference cost',
            costSubtitle: 'Last 7 days across all agents.',
            costInputTokens: 'Input tokens',
            costOutputTokens: 'Output tokens',
            costTotal: 'Cost',
            costViewDetailed: 'View detailed usage',
            breakdownCta: 'View storage & active-hours breakdown',
            loadError: 'Could not load plan & billing data.',
            topupSuccess:
                'Payment received. Your managed credit will update within a few moments.',
            topupCancel: 'Checkout canceled — no charge was made.',
            subscribeSuccess:
                'Subscription started. Your plan will update within a few moments.',
            subscribeCancel: 'Checkout canceled — your plan is unchanged.'
        },
        sandboxUsage: {
            title: 'Sandbox usage',
            subtitle:
                'What consumed your sandbox storage and active hours this billing period, per sandbox.',
            statStorage: 'Sandbox storage',
            statActiveHours: 'Active hours this period',
            statSandboxes: 'Sandboxes',
            storageSectionTitle: 'Storage by sandbox',
            storageSectionBody:
                'Each sandbox VM bills as a whole. The rows show what is inside it — per-agent workspaces and shared framework home dirs — as last measured while it ran.',
            vmDiskUsed: 'VM disk used: {{value}}',
            measuredAt: 'measured {{time}}',
            tagWorkspace: 'workspace',
            tagHomeShared: 'home · shared',
            systemOther: 'System & other',
            notMeasured:
                'Not measured yet — storage is measured inside the sandbox while it runs, at most every 5 minutes.',
            hoursSectionTitle: 'Active hours by sandbox',
            hoursSectionBody:
                'Hours accrue while a sandbox VM is running — a bare sandbox with an open terminal counts even with no agents. Hours are not tracked per agent.',
            colSandbox: 'Sandbox',
            colStatus: 'Status',
            colActive: 'Active time',
            colShare: 'Share',
            deletedSandbox: 'Deleted sandbox',
            deletedNote:
                'Time from sandboxes deleted this period still counts toward the meter.',
            loadError: 'Could not load sandbox usage.'
        },
        pricing: {
            title: 'Pricing',
            subtitle: 'Compare plans and upgrade your account.',
            colMetric: 'Metric',
            tierFreeTagline:
                'Great for getting started and seeing what Manyfold can do.',
            tierHobbyTagline:
                'For solo builders running a few agents in production.',
            tierPlusTagline:
                'For small teams collaborating across many agents.',
            tierProTagline: 'For teams running production workloads at scale.',
            tierHeadlineSandboxLabel: 'Sandbox agents',
            tierHeadlineAlwaysOnlineLabel: 'Always-online agents',
            tierFreeFeatures: {
                hours: '5 sandbox active hours / month',
                alwaysOnline: '1 always-online runtime',
                channels: '2 message channels',
                api: '5,000 API calls / month'
            },
            tierHobbyFeatures: {
                hours: '20 sandbox active hours / month',
                alwaysOnline: '3 always-online runtimes',
                channels: '8 message channels',
                api: 'Unlimited API calls'
            },
            tierPlusFeatures: {
                hours: '60 sandbox active hours / month',
                alwaysOnline: '10 always-online runtimes',
                channels: '25 message channels',
                history: '180 days message history'
            },
            tierProFeatures: {
                hours: '200 sandbox active hours / month',
                alwaysOnline: '30 always-online runtimes',
                channels: '100 message channels',
                history: 'Unlimited message history & automation runs'
            },
            detailsTitle: "What's included?",
            detailsBody:
                'Detailed limits per plan. Reach out if you need a custom tier.',
            sectionUsageBasedTitle: 'Usage-based runtimes',
            sectionAlwaysOnlineTitle: 'Always-online runtimes',
            sectionAccountTitle: 'Account limits',
            rowPrice: 'Monthly price',
            rowAgents: 'Sandbox VMs provisioned',
            rowConcurrent: 'Concurrent active sandboxes',
            rowStorage: 'Sandbox storage',
            rowActiveHours: 'Sandbox active hours / month',
            rowAlwaysOnlineRuntimes: 'Always-online runtimes',
            rowAlwaysOnlineAgents: 'Always-online agents',
            rowChannels: 'Channels',
            rowAutomations: 'Automations',
            rowAutomationRuns: 'Automation runs / month',
            rowMessageHistoryRetention: 'Message history retention',
            rowApiRequests: 'API requests / month',
            priceFree: 'Free',
            priceMonthly: '{{price}} / month',
            storageValue: '{{gb}} GB',
            hoursValue: '{{hours}} h',
            hoursUnlimited: 'Unlimited',
            unlimited: 'Unlimited',
            currentBadge: 'Current plan',
            subscribeCta: 'Subscribe',
            manageCta: 'Manage plan',
            loadError: 'Could not load current plan.'
        },
        home: {
            loadingAgents: 'Loading your agents...',
        },
        challenge: {
            status: {
                docTitle: 'Your status · Manyfold Agent Challenge',
                h1: 'Your challenge status',
                sub: 'From sign-up to Demo Day, this page shows where you are and what comes next. Entries close 12 Aug 24:00; Demo Day is 13 Aug 18:00.',
                loading: 'Loading your challenge status…',
                loadError: 'Could not load your status. Please try again.',
                retry: 'Try again',
                registeredAt: 'Registered {{date}}',
                support: {
                    b: 'Questions, or something not right?',
                    s: 'Two ways to reach us — pick whichever fits.',
                    cta: 'Contact support',
                    discord: 'Join the Discord',
                    discordNote: 'Ask in #{{channel}}, under {{category}}'
                },
                rail: {
                    register: 'Sign up',
                    review: 'Review',
                    submit: 'Entry',
                    judging: 'Shortlisting',
                    demoday: 'Demo Day'
                },
                signedOut: {
                    h: 'Sign in to see your challenge status',
                    p: 'Your status is tied to your Manyfold account. Sign in to see your progress — and if you have not registered yet, you can do that straight after.',
                    cta: 'Sign in'
                },
                notRegistered: {
                    h: 'You have not registered for the Agent Challenge',
                    p: 'Once your registration is approved, $30 of API credit lands in your account and you can start building. Participants get a Demo Day seat on 13 Aug automatically. Registration closes 12 Aug 24:00.',
                    cta: 'Register',
                    notOpenH: 'Registration opens 27 July',
                    notOpenP:
                        'Registration has not opened yet — it runs 27 Jul to 12 Aug 24:00. Once you register and are approved, $30 of API credit lands in your account and your Demo Day seat is confirmed automatically.',
                    closedH: 'Registration has closed',
                    closedP:
                        'Registration closed on 12 Aug at 24:00, so new entries can no longer be accepted. See the challenge page for what happens next: the shortlist and Demo Day on 13 Aug.'
                },
                reviewPending: {
                    pill: 'In review',
                    eta: 'Usually within 1 hour',
                    h: 'Registration received, review in progress',
                    p: 'We are confirming your account and eligibility — usually within an hour. Once approved, $30 API credit and one month of Manyfold Plus are released automatically and you can start building. The result shows up here.',
                    live: 'This page updates itself — once approved it turns into your build screen.'
                },
                approved: {
                    pill: 'Approved',
                    deadline: 'Entries close 12 Aug 24:00',
                    h: 'You are approved. Time to build 🎉',
                    p: 'Head to the workspace to orchestrate your agents, then submit your entry before 12 Aug 24:00. You can re-submit as often as you like until then — the last one counts.',
                    ctaWorkspace: 'Open the workspace',
                    ctaSubmit: 'Submit entry'
                },
                rejected: {
                    pill: 'Not approved',
                    window: 'You can re-register until 12 Aug 24:00',
                    h: 'Your registration was not approved',
                    p: 'Fix it and register again. Here is what did not pass this time.',
                    reasonTitle: 'Why it did not pass',
                    reasonFallback:
                        'We could not confirm your eligibility from the details you gave. Fill in the gaps and submit again.',
                    cta: 'Register again'
                },
                submitted: {
                    pill: 'Entry received',
                    at: 'Submitted {{date}}',
                    h: 'Your entry is in',
                    p: 'After entries close on 12 Aug the judges pick the shortlist, and the result shows up on this page. You can re-submit until then — the last version counts.',
                    chip: 'Editable until the deadline',
                    foot: 'Judges will open this link to try it. If it needs a login or an access code, put the details in your summary.',
                    cta: 'Re-submit'
                },
                unreachable: {
                    pill: 'Needs a fix',
                    window: 'Please fix before 12 Aug 24:00',
                    closed: 'Entries have closed',
                    h: 'We could not open your entry',
                    p: 'Fix it and re-submit, and your entry goes back into judging as normal.',
                    reasonTitle: 'The entry link would not load',
                    reasonFallback:
                        'The link you submitted did not load, so the judges cannot try it. Make sure the project is publicly deployed, and put any login or access code it needs in your summary.',
                    probeAt: 'Checked {{date}}',
                    cta: 'Re-submit'
                },
                judging: {
                    pill: 'Shortlisting',
                    notify: 'Result lands on this page',
                    h: 'Entries have closed and judging is under way',
                    p: 'The shortlist result shows up here as soon as it is decided. Your entry was locked when submissions closed on 12 Aug 24:00 and can no longer be changed.',
                    live: 'This page updates itself.',
                    chip: 'Locked'
                },
                finalist: {
                    pill: 'Shortlisted',
                    when: 'Demo Day 13 Aug 18:00',
                    h: 'You are on the shortlist — presenting 13 Aug 🎯',
                    p: 'Your entry made the shortlist and you are invited to present it live at Demo Day. Prizes are decided on the night: everyone who attends and completes a presentation wins something, with the ranking set by an audience vote. Not attending counts as forfeiting — prizes are only awarded on stage.',
                    briefTitle: 'Presenting on the night',
                    b1h: 'You get 10 minutes',
                    b1p: 'Explain the problem it solves and how you built it with agents.',
                    b2h: 'Lead with what makes it special',
                    b2p: 'Spend the time on your standout part — that is what wins votes.',
                    b3h: 'Record your demo in advance',
                    b3p: 'You are welcome to present live, but we strongly encourage recording your demo in advance to avoid technical issues on the day.'
                },
                notSelected: {
                    pill: 'Seat confirmed',
                    when: 'Demo Day 13 Aug 18:00',
                    h: 'The shortlist is out — see you at Demo Day',
                    p: 'Your entry is not among the ones presenting this time, but your seat is still reserved, with no further registration needed. We would still love to see you there — come see what everyone built and share what you have been building with AI agents. The final ranking also comes down to an audience vote, and you get one vote.'
                },
                presented: {
                    pill: 'Presented',
                    when: 'Demo Day 13 Aug — done',
                    h: 'You presented at Demo Day 🎉',
                    p: 'Everyone who presented wins something. The ranking was announced on the night, and your NetMind.AI API Credits go to your account — this page says so once they land.',
                    creditLabel: 'Prize credit',
                    creditNote:
                        'Released per the ranking announced on the night',
                    creditAmount: 'On the way',
                    cta: 'Keep building with Manyfold'
                },
                missed: {
                    pill: 'No entry',
                    closed: 'Entries closed 12 Aug 24:00',
                    h: 'You did not get an entry in — come to Demo Day anyway',
                    p: 'Your seat is already confirmed, no sign-up needed. Come on 13 Aug to see what everyone built; the ranking comes down to an audience vote, and you get one.'
                },
                credit: {
                    pendingLabel: 'Challenge credit',
                    pendingNote: 'Released once your registration is approved',
                    pendingAmount: 'Pending',
                    grantedLabel: 'Challenge credit delivered',
                    grantedNote: '$30 API credit + one month of Manyfold Plus',
                    grantedAmount: '$30.00'
                },
                event: {
                    label: 'Demo Day · Thu 13 Aug, 18:00',
                    note: 'Registering is your ticket. Joining details appear on this page.',
                    free: 'No sign-up',
                    addToCalendar: 'Add to calendar',
                    google: 'Google Calendar',
                    ics: 'Download .ics (Apple / Outlook)'
                },
                regCard: {
                    title: 'Your registration',
                    name: 'Name',
                    direction: 'Direction',
                    email: 'Contact email',
                    account: 'Manyfold account',
                    lockNote:
                        'Your Manyfold account comes from your sign-in and cannot be changed; the contact email can.',
                    edit: 'Edit'
                },
                workCard: {
                    titleOpen: 'Your entry',
                    titleLocked: 'The entry being judged',
                    desc: 'Summary',
                    foot: 'Judges will open this link to try it. If it needs a login or an access code, put the details in your summary.'
                },
                regModal: {
                    title: 'Registration',
                    sub: 'Three fields — your Manyfold account comes from your sign-in.',
                    name: 'Name',
                    namePh: 'Your name',
                    contact: 'Contact email',
                    direction: 'What you plan to build',
                    directionHint:
                        'A rough direction is enough; the actual project comes later, with your entry.',
                    cancel: 'Cancel',
                    submit: 'Submit'
                },
                workModal: {
                    title: 'Submit your entry',
                    sub: 'You can re-submit until 12 Aug 24:00 — the last version counts.',
                    name: 'Project name',
                    namePh: 'Name your project',
                    url: 'Project link',
                    urlPh: 'https://…',
                    urlHint:
                        'Judges will open this link to try it. If it needs a login or an access code, put the details in your summary.',
                    desc: 'Summary',
                    descPh: 'A line or two on what it does',
                    cancel: 'Cancel',
                    submit: 'Submit entry'
                },
                direction: {
                    multiAgent: 'Multi-agent orchestration',
                    content: 'Content processing / aggregation',
                    devtools: 'Developer tools / automation',
                    other: 'Something else / still deciding'
                }
            },
            error: {
                generic: 'Something went wrong. Please try again.',
                invalid: 'Please check the form and try again.',
                rateLimited:
                    'Too many requests — please wait a minute and try again.',
                notApproved:
                    'Submitting needs an approved registration. Check your review progress on the status page.',
                registrationClosed:
                    'Registration is not open right now — see the schedule on the challenge page.',
                alreadyApproved:
                    'Your registration is already approved — no need to sign up again.'
            },
            shellEntry: {
                dismiss: 'Dismiss challenge entry',
                join: {
                    title: 'Agent Challenge',
                    body: 'Join for a month of Plus and $30 credit',
                    cta: 'Join now'
                },
                pending: {
                    title: 'Application under review',
                    body: 'The reviewers’ verdict shows up on your status page',
                    cta: 'View your status'
                },
                rejected: {
                    title: 'Application not approved',
                    body: 'See the reason and how to apply again',
                    cta: 'See details'
                },
                approved: {
                    title: "You're in the Challenge",
                    body: 'Submissions close Aug 12, 24:00',
                    cta: 'Submit your project'
                },
                submitted: {
                    title: 'Project submitted',
                    body: 'You can update it until Aug 12, 24:00',
                    cta: 'View your submission'
                },
                unreachable: {
                    title: "We couldn't open your demo",
                    body: 'Fix the link before submissions close',
                    cta: 'Fix your link'
                },
                status: {
                    title: 'Agent Challenge',
                    body: 'See where your entry stands',
                    cta: 'View your status'
                }
            },
            doc: {
                title: 'Manyfold Agent Challenge · Agent App Sprint'
            },
            nav: {
                challengeActions: 'Challenge actions'
            },
            hero: {
                challengeDetails: 'Challenge schedule and rewards',
                eyebrow: 'AI Camp × Manyfold',
                h1a: 'Orchestrate your agents,',
                h1b: 'build your solution.',
                leadPerk:
                    'Enter to claim one month of Plus and $30 in API credit.',
                cta_cases: 'See the demos',
                reward: {
                    aria: 'Top builder rewards',
                    gold: {
                        place: 'Champion',
                        teams: '1 winner',
                        amount: '$100'
                    },
                    silver: {
                        place: 'Runner-up',
                        teams: '1 winner',
                        amount: '$40'
                    },
                    bronze: {
                        place: 'Third place',
                        teams: '1 winner',
                        amount: '$20'
                    },
                    excellence: {
                        place: 'Honorable mention',
                        teams: '× N',
                        amount: '$10'
                    },
                    poolLabel: 'Demo Day awards · NetMind.AI API credits',
                    foot: 'Every finalist who completes a Demo Day presentation wins: the top three receive place prizes, and all others receive an honorable mention.'
                },
                fact: {
                    period: {
                        k: 'Register · Build',
                        v: '27 Jul – 12 Aug'
                    },
                    eventday: {
                        k: 'Demo Day',
                        v: 'Thu 13 Aug, 18:00'
                    },
                    deadline: {
                        k: 'Submission deadline',
                        v: '12 Aug, 24:00'
                    }
                }
            },
            modal: {
                kicker: 'Manyfold · Agent challenge',
                apply: {
                    title: 'Sign up for the Manyfold Agent Challenge',
                    sub: 'Sign up to receive one month of Manyfold Plus and $30 Manyfold API credit, issued in one batch.'
                },
                submit: {
                    title: 'Submit your project',
                    sub: 'Submit and update any time until the deadline.'
                },
                close: 'Close'
            },
            cta: {
                registerShort: 'Join the challenge',
                see: 'See the challenge',
                preRegister: 'Opens 27 July',
                closedBanner: {
                    h: 'Challenge closed',
                    p: 'Further updates appear on your status page'
                },
                status: 'Your status'
            },
            round: {
                judging: {
                    h: 'Entries are closed',
                    p: 'Judging is under way. Shortlisted entries hear by email, and Demo Day is open to everyone.'
                },
                nextUp: {
                    h: 'This round has wrapped',
                    p: 'The next round opens on {{date}}.'
                },
                between: {
                    h: 'This round has wrapped',
                    p: 'The next round is being planned. Dates will be announced on this page.'
                },
                none: {
                    h: 'No round is running right now',
                    p: 'The challenge runs in rounds. Dates for the next one will be announced on this page.'
                },
                calendar: 'Add Demo Day to calendar'
            },
            f: {
                name: {
                    label: 'Name',
                    ph: 'Your name'
                },
                email: {
                    label: 'Contact email',
                    ph: 'you@example.com',
                    help: 'The address the organizers use if they need to reach you about your entry. Prefilled with your account email — change it if a different inbox is better.'
                },
                account: {
                    label: 'Manyfold account',
                    hint: 'Your Manyfold Plus and $30 API credit will be issued to this account.',
                    signedIn: 'Signed in to Manyfold',
                    switch: 'Switch',
                    switchTitle: 'Sign out and choose a different account'
                },
                gate: {
                    title: 'Sign in to receive your rewards',
                    body: 'Plus and API credit are issued to your Manyfold account, so joining needs you signed in. Your account also links your submission to the leaderboard.',
                    altPre: 'New to Manyfold? ',
                    altLink: 'Create an account',
                    signInCta: 'Sign in to continue',
                    pending: 'Checking your account…'
                },
                dir: {
                    label: 'What will you build?',
                    ph: 'e.g. A research agent that turns a weekly RSS + web-search sweep into a competitor brief.',
                    help: 'A sentence or two on your idea. You can refine it once you start building.'
                },
                apply: {
                    submit: 'Submit sign-up'
                },
                title: {
                    label: 'Project name',
                    ph: 'Name your project'
                },
                url: {
                    label: 'Project link or demo video',
                    ph: 'https:// a working link or video'
                },
                desc: {
                    label: 'Short description',
                    ph: 'What it solves or why it is fun'
                },
                submit: {
                    submit: 'Submit project'
                }
            },
            why: {
                h2a: 'One platform to orchestrate many agents into',
                h2x: 'a single app',
                h2b: '',
                p: 'The point of the sprint is to feel what Manyfold does: manage and orchestrate many agents in one workspace, mixing frameworks, model tiers and cost per task.',
                c1: {
                    h: 'Start for free',
                    p: 'Sign up to receive one month of Manyfold Plus and $30 Manyfold API credit, then start building.'
                },
                c2: {
                    h: 'Flexible orchestration',
                    p: 'Manage and orchestrate many agents in one workspace, picking the framework and model per task: cheap tiers for light work, top models where judgment matters.'
                },
                c3: {
                    h: 'Show your work',
                    p: 'Finalists are invited to present at Demo Day. Every project that completes a presentation wins: the top three receive place prizes, and all others receive an honorable mention.'
                }
            },
            cases: {
                h2a: 'Not sure what to build? Start from a',
                h2x: 'demo',
                h2b: '',
                p: 'Real projects running on Manyfold — open one and try it live. Gated demos show their access code on the card.',
                codeLabel: 'Access code',
                codeCopied: 'Copied'
            },
            case1: {
                p: 'Paste a Hacker News link, an article URL or raw text, and a pixel office of agents fetches, dissects and debates it — the whole run visualised live.',
                t1: 'Article analysis',
                t2: 'Pixel visualisation',
                link: 'View case',
                coverAlt: 'Article Lens pixel office with agents analysing an article'
            },
            case2: {
                p: 'Describe a trip in one sentence — agents parse the brief, check timezones, research destinations with live web search and print a ticket-style day-by-day booklet.',
                t1: 'Multi-agent pipeline',
                t2: 'Live web research',
                link: 'View case',
                coverAlt: 'Travel Ticket one-sentence trip brief with boarding info'
            },
            case3: {
                p: 'A bilingual channel workspace where people and A2A agents collaborate in real time — mention an agent and it replies right in the thread.',
                t1: 'A2A agents',
                t2: 'Realtime collaboration',
                link: 'View case',
                coverAlt: 'Team Agents bilingual workspace for people and A2A agents'
            },
            req: {
                h2a: 'What to',
                h2x: 'submit',
                h2b: '',
                p: 'This challenge is for solo participants; each entrant registers and submits independently. Once you sign up, start building with Manyfold; the rest is yours to define.',
                rule1: {
                    title: 'Build the core in Manyfold',
                    body: 'Use Manyfold for your agent deployment, orchestration or calls. The format is up to you.'
                },
                rule2: {
                    title: 'Make it usable',
                    body: 'Share an accessible service or demo, with a few words on the problem it solves.'
                },
                rule3: {
                    title: 'Explain your choices',
                    body: 'Show how agents, frameworks and models split the work. Cost, efficiency and delight all count.'
                },
                note: {
                    title: 'It does not need to be complex.',
                    body: 'A small tool that works reliably and can be reused is a stronger entry than a big concept that cannot run.'
                }
            },
            judge: {
                h2a: 'Evaluation',
                h2x: 'Criteria',
                h2b: '',
                p: 'Every project goes through three layers of evaluation, and finalists present live at Demo Day. Every project that completes a presentation wins, with attendees voting on the final ranking.',
                pts: 'pts',
                c1: {
                    title: 'Product completeness',
                    b1: 'Core flow works end to end: 20 pts',
                    b2: 'Usable and stable: 18 pts',
                    b3: 'Complete and reproducible explanation: 12 pts'
                },
                c2: {
                    title: 'Agent strategy & trade-offs',
                    b1: 'Agent, framework and model fit: 12 pts',
                    b2: 'Reasons for roles, comparison or selection: 12 pts',
                    b3: 'Cost, speed, quality and complexity trade-offs: 6 pts',
                    note: 'Agent count does not earn points.'
                },
                c3: {
                    title: 'Problem & insight',
                    b1: 'A real and clearly defined problem: 11 pts',
                    b2: 'A distinctive or original solution: 9 pts'
                }
            },
            timeline: {
                h2a: '',
                h2x: 'Schedule',
                h2b: ''
            },
            tl: {
                s1: {
                    when: '27 Jul',
                    h: 'Registration opens',
                    p: 'Claim Plus and credits, start building.'
                },
                s2: {
                    when: '7 Aug, 15:00',
                    h: 'Online session',
                    p: 'A live walkthrough of the flow and submissions, with Q&A.'
                },
                s3: {
                    when: '12 Aug, 24:00',
                    h: 'Registration and submissions close',
                    p: 'All public entries close and judging begins.'
                },
                s4: {
                    when: '13 Aug',
                    h: 'Judging & results',
                    p: 'Judges select finalists on a 100-point review, and every entrant sees the verdict on their status page. Finalists present at Demo Day — prizes are only awarded on stage, and not attending counts as forfeiting.'
                },
                s5: {
                    when: 'Thu 13 Aug, 18:00',
                    h: 'Demo Day',
                    p: 'Every finalist who completes a live presentation wins; attendees vote for the top three, and all others receive an honorable mention.'
                }
            },
            faq: {
                manualB: 'Everything you need is on this page:',
                manualS:
                    ' the full scoring rubric is under Evaluation Criteria above, and the GitHub / Cloudflare / Composio setup guides are in the FAQs below.',
                h2a: '',
                h2x: 'FAQs',
                h2b: '',
                p: 'Need help? Email hi@manyfold.ai — registration, setup and submission questions all reach the same team.',
                cat: {
                    a: 'About Manyfold',
                    b: 'Sign up & credit',
                    c: 'Configure & build',
                    d: 'Submit & help'
                },
                q1: 'Do I need to sign in to join?',
                a1: 'Yes. Rewards are issued to your Manyfold account, so joining takes a signed-in account, no user ID to copy. New to Manyfold? You can create one right from the sign-up dialog.',
                q2: 'Which agent tools can I connect?',
                a2: 'Manyfold can connect and orchestrate agent tools and frameworks such as Claude, Gemini CLI, Codex, Hermes and OpenClaw. Choose them by task when creating an agent, and mix models and tools when useful; model selection does not affect scoring. Availability follows the current provider and model list in Manyfold.',
                q3: 'Do I need my own API key?',
                a3: 'No. Registration comes with one month of Plus and $30 in credit; you can also connect your own providers.',
                q4: 'Where do I get help with technical problems?',
                a4: 'Email hi@manyfold.ai — the Manyfold team replies quickly on registration, setup, API and submission questions.',
                q5: 'How do I switch the model provider in Manyfold?',
                a5: 'Manyfold supports multiple providers and models. Open an Agent session, click Configure, and choose the provider that fits the task; you can also connect an API provider you already have and use the models and services you’re familiar with.',
                q6: 'How do I submit my project?',
                a6: {
                    intro: 'After signing up, build your project in the Manyfold workspace. Once your registration is approved, you can submit from this page or from your status page.',
                    s2: {
                        h: '01 · Finish and deploy',
                        p: 'Complete a working project and prepare a public project link or a 2–3 minute demo video. You may deploy anywhere; GitHub and Cloudflare are recommended.'
                    },
                    s3: {
                        h: '02 · Add your submission details',
                        p: 'Fill in the project name, a public link and a short description. Judges open the link to try it — if it needs a login or an access code, put the details in your summary.'
                    },
                    s4: {
                        h: '03 · Submit before the deadline',
                        p: 'Submit by 12 August at 24:00 (13 August, 00:00). You can reopen the form and update your details until the deadline; the latest version is used. Evaluators will select finalists, and your status page shows the verdict.'
                    }
                },
                qDemoOnly:
                    'Can I attend Demo Day without submitting a project?',
                aDemoOnly:
                    'Yes. Every registered participant keeps their Demo Day seat even without an entry — come, watch the finalists and cast your vote. There is no separate Demo Day sign-up; challenge registration (closes 12 August 24:00) is the only one.',
                qDemoDeadline: 'Do I need to sign up for Demo Day?',
                aDemoDeadline:
                    'No — there is no separate Demo Day registration. Your challenge registration (closes 12 August at 24:00, i.e. 13 August 00:00) is your ticket, and the joining details appear on your status page before 13 August.',
                qPresenter: 'Who will present on Demo Day?',
                aPresenter:
                    'After submissions close, judges select finalists and the verdict appears on each entrant’s status page; finalists present live at Demo Day. Prizes are only awarded on stage — a finalist who does not attend forfeits theirs. Every finalist who completes a presentation wins: the top three receive place prizes, and all others receive an honorable mention.',
                q7: 'How are NetMind.AI and Manyfold related?',
                a7: 'Manyfold is an AI agent integration platform developed under NetMind.AI. NetMind.AI provides the AI infrastructure and model resources; Manyfold focuses on the developer experience, bringing tools, frameworks and models together to build, deploy and manage multi-agent systems.',
                q8: 'What are GitHub, Cloudflare and Composio best for?',
                a8: {
                    composio: {
                        h: 'Composio: Connect external services',
                        p: 'Composio provides MCPs and integrations for a wide range of apps, including Google Workspace, Notion, Slack and GitHub. Agents can read data and take action directly, reducing the cost of building and validating API integrations yourself.'
                    },
                    github: {
                        h: 'GitHub: Code management and automated CI/CD',
                        p: 'GitHub is more than a code repository. GitHub Actions can automate testing, builds and deployments, making it easier for teams to establish a complete CI/CD workflow.'
                    },
                    cloudflare: {
                        h: 'Cloudflare: Deploy sites and services quickly',
                        p: 'Cloudflare Pages is suited to websites and frontend projects. When you need backend logic or serverless functions, pair it with Cloudflare Workers to deploy across a global edge network for better speed and availability.'
                    }
                },
                q9: 'How do I prepare authorisation for these connections?',
                a9: {
                    github: {
                        '1': 'Manyfold will usually guide you through GitHub OAuth.',
                        '2': 'If the connection asks for a token, create one in GitHub Settings → Developer settings → Personal access tokens with the permissions your project needs.',
                        '3': 'Return to the GitHub connection in Manyfold, complete authorisation or add the token, and save.',
                        h: 'GitHub'
                    },
                    composio: {
                        '1': 'After registering, open Installed from the left-hand menu.',
                        '2': 'Scroll to MCP URL, open it and copy the API key shown there.',
                        '3': 'Paste it into the Composio connection settings in Manyfold and save.',
                        h: 'Composio'
                    },
                    cloudflare: {
                        '1': 'Click your profile icon, then go to Profile → API Tokens → API Token Templates.',
                        '2': 'Choose the Edit Cloudflare Workers template, then set Account Resources to All accounts and Zone Resources to All zones.',
                        '3': 'Select Continue to summary → Create Token, then copy the token into the Cloudflare connection settings in Manyfold.',
                        h: 'Cloudflare'
                    }
                }
            }
        },
        landing: {
            worldTerminalDone: 'done',
            heroEyebrow: 'Manyfold · agent hosting & delivery',
            heroTitleBefore: 'Host your agents.',
            heroTitleAfter: 'Your work,',
            heroTitleAccent: 'multiplied.',
            heroTagline:
                'Claude Code, Codex and your own agents, always on and delivering into your product.',
            sceneHeroHint: 'Scroll · see how it works ↓',
            scene1Eyebrow: '01 · Hosting',
            scene1Title: 'Agents live in',
            scene1TitleAccent: 'runtimes.',
            scene1Lead:
                'Not tied to your laptop. Every agent gets a persistent home.',
            scene1Item1Label: 'Any framework',
            scene1Item1Body: 'Claude Code, Codex, Gemini CLI, and more',
            scene1Item2Label: 'Any machine',
            scene1Item2Body:
                'managed sandboxes, cloud computers, your own hardware',
            scene1Item3Label: 'Already built?',
            scene1Item3Body: 'plug in Dify, Langflow and external agents',
            scene2Eyebrow: '02 · One workspace',
            scene2Title: 'One place runs',
            scene2TitleAccent: 'all of them.',
            scene2Lead:
                'Whatever the framework, every agent shows up the same way.',
            scene2Item1Label: 'Sessions, files, terminal',
            scene2Item1Body: 'real workspaces, backed up',
            scene2Item2Label: 'Models per agent',
            scene2Item2Body: 'managed or bring your own provider',
            scene2Item3Label: 'Usage per turn',
            scene2Item3Body: 'tokens, cost and latency, always visible',
            scene3Eyebrow: '03 · Wherever you work',
            scene3Title: 'Same agent.',
            scene3TitleAccent: 'Every surface.',
            scene3Lead:
                'One capability, reachable from everywhere you already work.',
            scene3Item1Label: 'Your product',
            scene3Item1Body: 'call it over an OpenAI-compatible API',
            scene3Item2Label: 'Team chat & terminal',
            scene3Item2Body: 'Lark, Slack, WhatsApp, or the mf CLI',
            scene3Item3Label: 'Your schedule',
            scene3Item3Body: 'automations run it, results get delivered',
            scene4Eyebrow: '04 · The point',
            scene4Title: 'Your work,',
            scene4TitleAccent: 'multiplied.',
            scene4Lead:
                'PRs reviewed while you sleep. Reports drafted before standup. Tickets triaged before you open the queue. Your product and your team, running on more hands than you have.',
            worldGroundRuntime: 'Agent infrastructure',
            worldGroundPlane: 'Manyfold one control plane',
            worldGroundDelivery: 'Your product & workflows',
            worldRuntimeSandbox: 'Stateful sandboxes',
            worldRuntimeSandboxSub: 'As many as you need',
            worldRuntimeCloud: 'Cloud computer',
            worldRuntimeCloudSub: 'Always on',
            worldRuntimeOwn: 'Your own machine',
            worldRuntimeOwnSub: 'Laptop or server',
            worldRuntimeExternal: 'External services',
            worldRuntimeExternalSub: 'Bring what you have',
            worldPlaneSessions: 'Sessions & files',
            worldPlaneModels: 'Models',
            worldPlaneSkills: 'Skills & MCP',
            worldPlaneUsage: 'Usage & cost',
            worldPlaneOrchestration: 'Agent orchestration',
            worldPlaneOrchestrationSub: 'Routes work across agents',
            worldSurfaceProduct: 'Your product',
            worldSurfaceProductVia: 'Via API',
            worldSurfaceChat: 'Team chat & phone',
            worldSurfaceChatVia: 'Via channels',
            worldSurfaceTerminal: 'Your terminal',
            worldSurfaceTerminalVia: 'Via CLI',
            worldSurfaceSchedule: 'Your schedule',
            worldSurfaceScheduleVia: 'Via automations',
            worksWithEyebrow: 'Works with',
            worksWithTitle: 'Bring what you',
            worksWithTitleAccent: 'already use.',
            worksWithLead:
                'Frameworks keep their native behaviour. Channels reach your team where they are. Runtimes are yours to pick.',
            worksWithFrameworks: 'Frameworks',
            worksWithChannels: 'Channels',
            worksWithRuntimes: 'Runtimes',
            worksWithSandbox: 'Stateful sandbox',
            worksWithCloud: 'Cloud computer',
            worksWithOwn: 'Your own machine',
            meterMonthToDate: 'month to date',
            obsEyebrow: 'Observability',
            obsTitle: 'Every run,',
            obsTitleAccent: 'on the record.',
            obsLead:
                'Transcripts, cost and permissions for every turn — including the runs that happened while you were asleep.',
            obsPoint1Label: 'Transcript.',
            obsPoint1Body:
                'Every turn kept — the prompt, the tool calls, the files it touched. Pick the session back up weeks later.',
            obsPoint2Label: 'Cost.',
            obsPoint2Body:
                'Tokens, latency, model and price per turn, across every provider you use.',
            obsPoint3Label: 'Control.',
            obsPoint3Body:
                'Every permission an agent asked for, and what you answered, on the same record.',
            obsAllowed: 'Allowed',
            obsDenied: 'Denied',
            pricingEyebrow: 'Plans',
            pricingPopular: 'Popular',
            faqEyebrow: 'Questions',
            signIn: 'Sign in',
            openWorkspace: 'Open workspace',
            stepCtaStep1: 'Step 1',
            stepCtaStep2: 'Step 2',
            navPricing: 'Pricing',
            navDocs: 'Docs',
            navChallenge: 'Challenge',
            heroPrimaryCta: 'Create your first agent',
            faqQ1: 'Is this just a wrapper around Claude Code or Codex?',
            faqA1: 'No. Each framework runs in its native form, with its own execution model, model configuration and workspace semantics. Manyfold is the layer around them: runtime, workspace, orchestration, delivery and metering. When a framework ships something new, you get it the same day.',
            faqQ2: 'How is this different from a VM with agents installed?',
            faqA2: 'A VM gives you compute. Manyfold gives you the part you would build next: framework bootstrap, persistent sessions, files and terminal, model configuration, skills and MCP, channels, automations and per-turn usage, for every agent, in one place.',
            faqQ3: 'Do I have to rebuild the agents I already have?',
            faqA3: 'No. Connect your own laptop or server with the mf daemon, or plug in Dify, Langflow and other supported services as adapted work units. External runtimes keep their own capability boundaries, and we say where those boundaries are rather than pretending they do not exist.',
            faqQ4: 'What exactly does the API expose?',
            faqA4: 'Your hosted agent behind an OpenAI-compatible endpoint, so existing SDKs work unchanged. Calls join the same session, permission and usage system as the web workspace. It is an agent you manage, not a bare model proxy.',
            faqQ5: 'Which surface should my team start with?',
            faqA5: 'Most developers start in the web workspace, then wire the API into a product or a channel into team chat. Ops-minded teams often start with a schedule and a channel. Every surface reaches the same agents, so the order costs you nothing.',
            footerLegal: '© 2026 Manyfold',
            footerDocs: 'Docs',
            footerChallenge: 'Agent Challenge',
            footerChangelog: 'Changelog',
            footerStatus: 'Status',
            footerPrivacy: 'Privacy',
            footerTerms: 'Terms',
            footerCookies: 'Cookie settings',
            faqTitleBefore: 'The ones that',
            faqTitleAccent: 'decide it.',
            faqLead:
                'If you are weighing this against building it yourself, start here.',
            ctaSecondaryCta: 'Read the docs',
            pricingTitleBefore: 'Start free.',
            pricingTitleAccent: 'Scale when ready.',
            pricingLead:
                'Every plan runs the same platform. Pick the limits that fit how many agents you keep online.',
            pricingPerMonth: '/ mo',
            pricingFree: 'Free',
            pricingCtaFree: 'Get started',
            pricingCtaPaid: 'Choose {{plan}}',
            pricingSandboxLabel: 'Sandbox agents',
            pricingAlwaysOnlineLabel: 'Always-online agents',
            pricingNote:
                'Prices in USD. Cancel anytime. Need a custom tier? Reach out and we will size it with you.'
        },
        consent: {
            message:
                'We use Google Analytics to understand how Manyfold is used. It only runs if you accept, and you can change your choice at any time.',
            accept: 'Accept analytics',
            decline: 'Decline',
            privacyLink: 'Privacy policy',
            settingsTitle: 'Analytics cookies',
            settingsDescription:
                'Google Analytics helps us understand product usage. It sets _ga cookies and only runs with your consent.',
            statusGranted: 'Analytics is on',
            statusDenied: 'Analytics is off',
            statusUnset: 'No choice made yet',
            enable: 'Turn on',
            disable: 'Turn off'
        },
        skills: {
            reposTab: 'Skill repositories',
            reposSubtitle:
                'Add GitHub repositories to pull community skills from, and enable or disable the built-in sources.',
            installedTitle: 'Installed skills',
            discoverAction: 'Discover skills',
            createAgentAction: 'New agent',
            emptyAgentBody: 'No skills installed for this agent.',
            emptyHermesAgentBody:
                'No NCA managed skills installed, and no runtime skills were found in this Hermes profile.',
            skillCount: '{{count}} skills',
            managedSource: 'Managed',
            runtimeSource: 'Runtime',
            runtimeReadonly: 'Read-only runtime skill',
            inventoryWarning: 'Runtime skill scan failed: {{message}}',
            enabled: 'Enabled',
            disabled: 'Disabled',
            enableAction: 'Enable',
            disableAction: 'Disable',
            uninstallAction: 'Uninstall',
            updateAction: 'Update',
            updateAvailable: 'Update available',
            statusInstalling: 'Installing…',
            statusFailed: 'Install failed',
            retryAction: 'Retry',
            installAction: 'Install',
            installFirstPartyTitle: 'Install the Manyfold CLI skill',
            installFirstPartyBody:
                'manyfold-cli-usage teaches this agent to use the mf CLI. It is installed by default on new agents — add it here if it is missing.',
            searchPlaceholder: 'Search skills',
            searchAction: 'Search',
            noResultsTitle: 'No skills found',
            noResultsBody:
                'Try another search or add a repository that contains SKILL.md files.',
            ownerPlaceholder: 'owner',
            repoPlaceholder: 'repository',
            branchPlaceholder: 'branch',
            addRepoAction: 'Add repo',
            removeRepoAction: 'Remove',
            builtinRepo: 'Built-in',
            customRepo: 'Custom',
            library: {
                empty: 'Pick a ready-made skill from the catalog, or create one from scratch, import from GitHub, or upload an archive.',
                emptyTitle: 'Your skill library is empty',
                newSkill: 'New skill',
                createTitle: 'New skill',
                methodManual: 'Manual',
                methodUrl: 'From URL',
                methodUpload: 'Upload',
                nameLabel: 'Name',
                descriptionLabel: 'Description',
                urlLabel: 'GitHub URL',
                urlHint:
                    'Supports github.com repository URLs, tree links to a skill folder, or SKILL.md blob links.',
                uploadLabel: 'Skill archive',
                uploadChoose: 'Choose a .skill or .zip file',
                createAction: 'Create',
                importAction: 'Import',
                conflictOverwrite: 'Overwrite',
                conflictRename: 'Keep both',
                conflictMessage:
                    'A skill named "{{name}}" already exists in your library.',
                copyToLibrary: 'Copy to library',
                badge: 'Library',
                edit: 'Edit',
                export: 'Export',
                install: 'Install',
                delete: 'Delete',
                deleteConfirm:
                    'Delete "{{name}}" from your library? This cannot be undone.',
                deleteForceConfirm:
                    'This skill is installed on {{count}} agents. Deleting it will also uninstall it from those agents. Delete anyway?',
                files: 'Files',
                addFile: 'Add',
                newFile: 'New file',
                addFilePlaceholder: 'references/notes.md',
                preview: 'Preview',
                editTab: 'Edit',
                save: 'Save',
                discard: 'Discard',
                saved: 'Saved',
                unsaved: 'Unsaved',
                backToLibrary: 'My skills',
                installedOn: 'Installed on {{count}} agents',
                updatedOn: 'Updated {{date}}',
                moreActions: 'More actions',
                originManual: 'Manual',
                originGithub: 'GitHub',
                originArchive: 'Archive',
                originCatalog: 'Catalog',
                originShare: 'Shared',
                selectAgents: 'Select agents',
                installedChip: 'Installed',
                installSelected: 'Install to {{count}} agent(s)',
                installResultFailed: 'failed',
                pushAction: 'Push to agents',
                pushDone: 'Pushed to {{count}} agent(s)',
                pushPartial: 'Pushed to {{ok}} agent(s), {{failed}} failed',
                uploadFiles: 'Upload files',
                newFileHere: 'New file here',
                rename: 'Rename',
                renameFolder: 'Rename folder',
                renameTitle: 'Rename "{{name}}"',
                renamePathLabel: 'New path',
                deleteFolder: 'Delete folder',
                deleteFolderConfirm:
                    'Delete folder "{{name}}" and its {{count}} file(s)? They are removed when you save.',
                pathInvalid:
                    'Invalid path. Start with a letter or digit; use letters, digits, spaces, . _ - and / only.',
                pathReserved:
                    'SKILL.md is reserved for the primary skill content.',
                pathExists: '"{{path}}" already exists.',
                pathConflictsDir:
                    '"{{path}}" conflicts with an existing folder or file.',
                uploadRejected: '{{count}} file(s) were not added:',
                uploadBinary:
                    '{{name}}: not a text file (only text files are supported).',
                uploadTooLarge: '{{name}}: exceeds 1 MiB.',
                uploadTooMany: 'Too many files (max {{count}} per skill).',
                uploadTotalTooLarge:
                    'Skill would exceed the 8 MiB total size limit.',
                uploadOverwriteTitle: 'Overwrite existing files?',
                uploadOverwriteBody:
                    '{{count}} file(s) already exist and will be replaced: {{paths}}',
                share: 'Share',
                shareTitle: 'Share "{{name}}"',
                shareIntro:
                    'Create an unlisted link so anyone with it can view this skill and add a copy to their own library.',
                shareActiveHint:
                    'Anyone with this link can view the current version of this skill and import a copy. Your later edits stay visible until you stop sharing.',
                shareCreate: 'Create link',
                shareCopy: 'Copy',
                shareCopied: 'Copied',
                shareCopyFailed: 'Could not copy the link to the clipboard.',
                shareReset: 'Reset link',
                shareRevoke: 'Stop sharing',
                shareImportCount: 'Imported {{count}} time(s) via this link.',
                doneEditing: 'Done',
                discardEditsTitle: 'Discard changes?',
                discardEditsBody:
                    'You have unsaved changes. Discard them and return to the view?',
                metaOrigin: 'Origin',
                metaCreated: 'Created'
            },
            shared: {
                notFoundTitle: 'This share link is not available',
                notFoundBody:
                    'The link may have been revoked, or the skill no longer exists.',
                backHome: 'Go to Manyfold',
                sharedBy: 'Shared by {{name}}',
                sharedAnon: 'Shared skill',
                import: 'Add to my library',
                signInToImport: 'Sign in to add',
                filesTitle: '{{count}} bundled file(s)'
            }
        },
        customize: {
            connectionCreate: {
                title: 'New connection',
                description:
                    'Link an external account so agents authenticate automatically.',
                connecting: 'Connecting…',
                continueGithub: 'Continue to GitHub',
                confirmAccount: 'Confirm account',
                connectCloudflare: 'Connect Cloudflare',
                connectComposio: 'Connect Composio',
                provider: 'Provider',
                githubDescription:
                    "Install the Manyfold GitHub App and pick the repositories agents may access. Short-lived tokens are minted per run — nothing long-lived is stored. You'll be redirected to GitHub to finish.",
                cloudflareDescription:
                    'Paste a Cloudflare API token. The link below pre-fills the permissions agents need (Account: Read + Workers / Pages / DNS: Edit) — review and create, then paste it here.',
                createTokenLink: 'Create a pre-filled token →',
                apiToken: 'API token',
                cloudflareTokenPlaceholder: 'Cloudflare API token',
                labelOptional: 'Label (optional)',
                cloudflareLabelPlaceholder: 'e.g. Acme production',
                account: 'Account',
                composioDescription:
                    "Paste your Composio Connect API key (Composio dashboard → AI Clients). It's stored securely as the x-consumer-api-key for the Composio Connect MCP server.",
                connectKeyLink: 'Get your Connect key →',
                connectApiKey: 'Connect API key',
                composioKeyPlaceholder: 'Composio Connect API key',
                composioLabelPlaceholder: 'e.g. Personal'
            },
            connectionDetail: {
                manageRepoAccess: 'Edit repo access ↗',
                manageToken: 'Edit token ↗',
                renameTitle: 'Rename connection',
                allRepositories: 'All repositories',
                selectedRepositories: '{{count}} selected repositories',
                loadingRepositories: 'Loading repositories…',
                noRepositories:
                    'No repositories granted. Use “Edit repo access” above to grant some on GitHub.',
                pushedAt: ' · pushed {{date}}',
                private: 'Private',
                showingRepositories:
                    'Showing the first {{shown}} of {{total}} repositories.',
                repositories: 'Repositories',
                cloudflareResources: 'Cloudflare resources',
                couldNotLoad: 'Could not load {{resource}}.',
                tokenLacksPermission:
                    'The token lacks the {{resource}}: Read permission.',
                noResources: 'No {{resource}} in this account.',
                loadingWorkersPages: 'Loading Workers and Pages…',
                tokenStatus: 'Token {{status}}',
                workers: 'Workers',
                pages: 'Pages',
                updatedAt: 'updated {{date}}',
                deployedAt: 'deployed {{date}}',
                mcpTools: 'MCP tools',
                exposedTools: '{{count}} exposed',
                composioToolsDescription:
                    'Tools the Composio Connect MCP server currently exposes for this key — what a linked agent actually gets. Bind or unbind toolkits on the',
                composioDashboard: 'Composio dashboard ↗',
                loadingTools: 'Loading tools…',
                noTools: 'The MCP server exposes no tools for this key yet.',
                connectApiKey: 'Connect API key',
                hide: 'Hide',
                show: 'Show',
                linkedAgents: 'Linked agents',
                loadingAgents: 'Loading agents…',
                noLinkedAgents:
                    'No agents use this connection yet. Bind one below — its next run picks it up automatically.',
                unbind: 'Unbind',
                bindAgentPlaceholder: 'Bind an agent…',
                backToConnections: 'Back to connections',
                notFound: 'Connection not found.',
                removeTitle: 'Remove {{provider}} connection?',
                removeDescription:
                    'Agents linked to "{{name}}" lose access on their next run.',
                remove: 'Remove',
                rename: 'Rename',
                overview: 'Overview',
                provider: 'Provider',
                installation: 'Installation',
                accountId: 'Account ID',
                connected: 'Connected',
                updated: 'Updated'
            },
            navSkills: 'Skills',
            navMcp: 'MCP',
            navConnections: 'Connections',
            navMySkills: 'My skills',
            navSkillsCatalog: 'Skill catalog',
            navMyMcp: 'My MCP',
            navMcpCatalog: 'MCP catalog',
            skillsGroupDesc:
                'Browse community skills, save them to your library, or build and manage your own.',
            mcpGroupDesc:
                'Connect MCP servers to give your agents new tools and data sources.',
            connectionsGroupDesc:
                'Credentials your agents use at runtime. Bind one to an agent and its next run picks it up.',
            layoutBody:
                'Skills, MCP servers and connections are shared across all your agents.',
            browseSkillsCatalog: 'Browse skill catalog',
            browseMcpCatalog: 'Browse MCP catalog',
            myMcpEmptyTitle: 'No MCP configurations yet',
            myMcpEmptyBody:
                'Create an MCP server configuration once, then install it to any compatible agent.',
            myMcpNew: 'New MCP',
            myMcpEdit: 'Edit',
            myMcpInstall: 'Install',
            myMcpCopyToLibrary: 'Copy to library',
            myMcpDelete: 'Delete',
            myMcpDeleteConfirm:
                'Delete {{name}} from My MCP? Existing agent configurations are not removed.',
            myMcpCreateTitle: 'New MCP configuration',
            myMcpEditTitle: 'Edit MCP configuration',
            myMcpFormSubtitle:
                'This reusable definition is converted to the selected agent framework when installed.',
            myMcpNameLabel: 'Name',
            myMcpKeyLabel: 'Server key',
            myMcpKeyHint:
                'Used as the server name in agent config. Lowercase letters, numbers, - and _ only.',
            myMcpDescriptionLabel: 'Description (optional)',
            myMcpTransportLabel: 'Transport',
            myMcpUrlLabel: 'Server URL',
            myMcpHeadersLabel: 'Headers (optional)',
            myMcpHeadersHint:
                'JSON object with string values. Credentials entered here are copied to installed agent configurations.',
            myMcpCommandLabel: 'Command',
            myMcpArgsLabel: 'Arguments (optional)',
            myMcpArgsHint: 'One argument per line.',
            myMcpEnvLabel: 'Environment variables (optional)',
            myMcpEnvHint:
                'JSON object with string values. Credentials entered here are copied to installed agent configurations.',
            myMcpInvalidRecord:
                'Headers and environment variables must be JSON objects with string values.',
            backToSkills: 'Skills',
            backToMcp: 'MCP',
            skillNotFoundTitle: 'Skill not found',
            skillNotFoundBody:
                'This skill is not in the current catalog. It may have been removed from its repository.',
            installToAgent: 'Install to agent',
            selectAgent: 'Select agent',
            alreadyInstalled: 'Already installed on this agent.',
            noSkillAgents:
                'No agents can use skills yet. Create a Claude Code, Codex, Gemini CLI, or Hermes agent first.',
            installSuccess: 'Installed to {{agent}}.',
            viewInAgent: 'View in agent settings',
            connectionsNew: 'New connection',
            connectionsUnbound: 'Not bound',
            connectionsBoundOne: '1 agent',
            connectionsBoundMany: '{{count}} agents',
            connectionsCallbackSuccess: 'GitHub connected.',
            connectionsCallbackError:
                'GitHub connection failed. Please try again.',
            connectionsCallbackErrorReason:
                'GitHub connection failed: {{reason}}. Please try again.',
            transportHttp: 'Remote (HTTP)',
            transportStdio: 'Local (stdio)',
            mcpNotFound: 'MCP server not found',
            visitHomepage: 'Visit homepage',
            configPreview: 'Config preview',
            placeholdersNote:
                'Replace the ${...} placeholders with your own credentials after installing — edit them in the agent MCP settings.',
            invalidExistingConfig:
                'The agent has invalid MCP config in this scope. Fix it in the agent MCP settings first.',
            alreadyConfigured:
                'This server is already configured in the selected scope.',
            noMcpAgents:
                'No agents support MCP yet. Create a Claude Code, Codex, or Gemini CLI agent on a sandbox or your own computer first.',
            selectScope: 'Config scope',
            allCategories: 'All categories',
            sortFeatured: 'Featured',
            sortLatest: 'Latest',
            featuredBadge: 'Featured',
            loadMore: 'Load more',
            loadingMore: 'Loading more…',
            mcpSearchPlaceholder: 'Search MCP servers',
            mcpEmptyTitle: 'No MCP servers found',
            mcpEmptyBody: 'Try another search or clear the filters.',
            aboutTitle: 'About',
            installCount: '{{count}} installs',
            neverUpdated: 'Not yet synced',
            installHint:
                'The agent walks you through any setup the first time it uses this skill.',
            requirementsTitle: 'Before you install',
            requirementsIntro: 'This skill needs the following secrets:',
            createSecretAt: 'Create it at {{provider}}',
            infoTitle: 'Details',
            metaVersion: 'Version',
            metaLicense: 'License',
            metaPlatforms: 'Platforms',
            viewSourceOnGithub: 'View source on GitHub',
            tagsTitle: 'Category & tags',
            readmeMissing: 'No documentation available for this skill yet.'
        },
        runtimeSession: {
            viewerLabel: 'Agent sessions',
            sessionActions: 'Session actions',
            loadingList: 'Scanning sessions on the runtime…',
            loadingParsing: 'Reading the selected session…',
            loadingRaw: 'Loading raw session content…',
            previewTruncated:
                'Showing the latest {{shown}} of {{total}} messages',
            rawTruncated: 'Showing the first {{shownKb}} KB of {{totalKb}} KB',
            messageCount: '{{count}} messages',
            noAssistantReply: 'No reply yet',
            back: 'Back to sessions',
            emptyTitle: 'No sessions',
            emptyBody:
                'Conversations with this agent show up here, whether they were started in the web app or run on its runtime.',
            localScanUnavailable:
                'The runtime could not be reached, so this list shows what the cloud holds. Sessions may also exist on the runtime.',
            inCloud: 'Cloud',
            inLocal: 'Local',
            copyResumeCommand: 'Copy resume command',
            copySessionId: 'Copy session ID',
            copyFilePath: 'Copy file path',
            resumeUnsupported:
                'This framework CLI cannot be pointed at a session by id.',
            notOnRuntime: 'This session is not on the runtime.',
            emptyParsedMessages: 'No messages parsed from this local session.',
            emptyRawContent: 'No raw content in this local session.',
            currentWebSession: 'Current',
            viewSection: 'View',
            preview: 'Preview',
            raw: 'Raw',
            restoreRaw: 'Restore raw',
            restoring: 'Restoring',
            openSession: 'Open session',
            opening: 'Opening',
            restoreSession: 'Restore session',
            rebuildParsed: 'Rebuild parsed',
            rebuilding: 'Rebuilding',
            restoreRawTitle: 'Restore missing raw message cache',
            openSessionTitle:
                'Open the existing cloud session for this runtime session',
            restoreSessionTitle:
                'Import this runtime session into the cloud DB',
            rebuildParsedTitle:
                'Re-parse this runtime session and replace the cloud parsed messages'
        },
        chatStream: {
            connecting: 'Connecting…',
            thinking: 'Thinking…',
            responding: 'Responding…',
            runningTool: 'Running {{tool}}…',
            cancelling: 'Stopping…',
            cancelled: 'Stopped',
            suspended: 'Waiting for the device to reconnect…',
            recovering: 'Recovering this answer…',
            resuming: 'Resuming this answer…',
            stalled: 'No output for a while, still waiting…',
            working: 'Working…',
            tokensNotReported: 'Tokens not reported by this agent',
            modelUnknown: 'model unknown',
            messageDetails: 'Message details',
            tokensTotal: '{{count}} total',
            tokensIn: 'in {{count}}',
            tokensOut: 'out {{count}}',
            cacheRead: 'cache read {{count}}',
            cacheCreate: 'cache create {{count}}',
            cost: 'cost',
            latency: 'latency',
            latencyTtf: 'ttf {{seconds}}s',
            latencyTotal: 'total {{seconds}}s',
            model: 'model',
            time: 'time',
            waitingForPermission: 'Waiting for your approval…',
            contextUsage: 'context',
            contextUsageValue: '{{used}} / {{size}} ({{percent}}%)',
            copyText: 'Copy text',
            copiedText: 'Copied text',
            copyMarkdown: 'Copy markdown text',
            copiedMarkdown: 'Copied markdown text',
            copyRaw: 'Copy raw response',
            copiedRaw: 'Copied raw response'
        },
        chat: {
            permissionCard: {
                approvedWith: 'Approved · {{option}}',
                denied: 'Denied',
                timedOut: 'Timed out — denied',
                cancelled: 'Cancelled with the turn',
                expired: 'This request is no longer waiting for an answer.',
                sending: 'Sending…',
                answerFailed: 'Could not deliver the answer: {{message}}'
            },
            header: {
                openMenu: 'Open menu',
                share: 'Share chat',
                openTerminal: 'Open terminal',
                refresh: 'Refresh chat and files'
            },
            pane: {
                label: 'Chat side panel',
                select: 'Select panel',
                close: 'Close panel',
                resize: 'Resize panel',
                backgroundTasks: 'Background tasks',
                files: 'Files',
                runtimeSession: 'Agent sessions'
            },
            agentStatus: {
                pending: 'Pending',
                running: 'Running',
                stopped: 'Stopped',
                failed: 'Failed',
                cold: 'Cold',
                warm: 'Warm',
                notReady: 'Not ready',
                containerCreating: 'Container creating',
                podInitializing: 'Pod initializing',
                crashLoopBackOff: 'Crash loop back-off',
                imagePullBackOff: 'Image pull back-off',
                errImagePull: 'Image pull error',
                createContainerConfigError: 'Container config error',
                createContainerError: 'Container creation error',
                invalidImageName: 'Invalid image name',
                unknown: 'Unknown',
                succeeded: 'Succeeded'
            },
            process: 'Process {{label}}',
            result: 'result',
            copyCode: 'Copy code',
            denied: 'Denied',
            failed: 'Failed',
            thinking: 'Thinking…',
            thought: 'Thought',
            thoughtFor: 'Thought for {{elapsed}}',
            loadingConversation: 'Loading conversation…',
            loadingRuntimeViewer: 'Loading agent sessions…',
            loadingModelOptions: 'Loading model options…',
            savingDraftAndSending: 'Saving draft and sending…',
            stoppingResponse: 'Stopping response…',
            streamingEsc: 'Streaming… Esc to cancel',
            whatNext: 'What should {{name}} work on next?',
            sessionMessageLimit:
                'This session has {{count}} messages. Consider starting a new session for better performance.',
            failedToCreateSession: 'Failed to create chat session.',
            runtimeSignIn: {
                title: 'Sign in to use your subscription',
                body: 'This agent runs on the credentials signed in on its runtime. Open the terminal, complete the sign-in there, then refresh.',
                claudeHint:
                    'open the printed link, sign in, then paste the code back when asked.',
                codexHint:
                    'approve the device code from any browser (device-code sign-in may need enabling in your ChatGPT security settings).',
                geminiHint: 'open the printed link and paste the code back.',
                openTerminal: 'Open terminal',
                refresh: 'Refresh status',
                checking: 'Checking…'
            },
            generating: 'Generating',
            tokensLabel: 'tokens',
            tools: {
                toolCall: 'Tool call',
                editOf: 'edit {{current}} of {{total}}',
                editCount: '{{count}} edit',
                editsCount: '{{count}} edits',
                inPath: '{{pattern}}  in  {{path}}',
                read: 'Read',
                write: 'Write',
                edit: 'Edit',
                bash: 'Bash',
                grep: 'Grep',
                glob: 'Glob',
                item: 'item',
                items: 'items',
                noContent: '(no content)',
                earlierLinesHidden: '{{count}} earlier lines hidden — show all',
                subagent: 'subagent',
                task: 'task',
                step: 'step',
                steps: 'steps',
                working: 'subagent working…',
                noRecordedSteps: '(no recorded steps)',
                summary: 'subagent summary',
                emptyDiff: 'empty diff',
                moreLinesTruncated: '… {{count}} more lines truncated',
                todos: 'todos',
                webFetch: 'Web fetch',
                webSearch: 'Web search',
                notebookEdit: 'Notebook edit',
                applyPatch: 'Apply patch',
                updatePlan: 'Update plan'
            },
            share: {
                title: 'Share "{{name}}"',
                untitledSession: 'Untitled chat',
                intro: 'Create an unlisted link so anyone with it can view this conversation up to this point. Messages sent after sharing stay private.',
                activeHint:
                    'Anyone with this link can view this conversation up to the moment it was shared. New messages stay private.',
                create: 'Create link',
                copy: 'Copy',
                copied: 'Copied',
                copyFailed: 'Could not copy the link to the clipboard.',
                reset: 'Reset link',
                revoke: 'Stop sharing'
            },
            shared: {
                notFoundTitle: 'This share link is not available',
                notFoundBody:
                    'The link may have been revoked, or the conversation no longer exists.',
                backHome: 'Go to Manyfold',
                sharedBy: 'Shared by {{name}}',
                sharedAnon: 'Shared conversation',
                untitled: 'Untitled chat',
                openApp: 'Open Manyfold',
                signInCta: 'Sign in'
            },
            loadingOlder: 'Loading earlier messages…',
            scrollForOlder: 'Scroll up for earlier messages',
            scrollToBottom: 'Scroll to bottom',
            copyMessage: 'Copy message',
            copiedMessage: 'Copied',
            copy: 'Copy',
            copied: 'Copied',
            editMessage: 'Edit message',
            error: {
                modelAuth:
                    'The model provider rejected the request — its sign-in or API key is invalid or expired. Update the model provider credentials and try again.',
                modelBilling:
                    'The model provider rejected the request — the key may be out of credit. Update the key or switch to platform credits.',
                updateKey: 'Update key',
                switchToPlatform: 'Switch to platform credits',
                switching: 'Switching…',
                switchedToPlatform:
                    'Switched to platform credits. Send your message again.',
                detailLabel: 'Details'
            }
        },
        permissions: {
            requestTitle: 'Permission request',
            requestExpired:
                'This permission request has expired or is no longer valid. Ask the agent to request access again.',
            requestNotFound:
                'This permission request was not found. It may have already been handled, or it belongs to a different account.',
            requestingAgent: 'Requesting agent',
            capabilitiesRequested: 'Capabilities requested',
            capabilitiesHint:
                'Choose what to grant. High-risk capabilities start unchecked — opt in only if you trust this agent.',
            selectCapability: 'Select at least one capability to grant.',
            loadingRequest: 'Loading permission request…',
            granting: 'Granting…',
            approve: 'Approve',
            deny: 'Deny',
            close: 'Close',
            granted: 'Granted {{count}} {{capability}} to {{name}}',
            capability: 'capability',
            capabilities: 'capabilities',
            notRequested: 'not requested',
            agentContinuing: 'The agent is continuing.',
            declined: 'Permission request declined.',
            reviewApprove: 'Review & approve',
            reviewTitle: 'Review permission request',
            reviewDescription: 'Existing permissions are kept — this only adds what you approve.',
            requestUnavailable:
                'This permission request has expired or was already handled. Ask the agent to request access again.',
            updated:
                'Permissions updated. The agent picks up the new capabilities on its next request.',
            grantDoneHint:
                'The agent will pick up its new permissions and continue. You can close this window.',
            pageTitle: 'Agent permission request',
            pageSubtitle: 'Review what this agent is asking for',
            openRequestPage: 'Open the request page',
            wantsCapabilities: 'wants new capabilities. Review and approve to let it continue.',
            wantsCapabilitiesGeneric:
                'This agent wants new capabilities. Review and approve to let it continue.',
            grantSummary: 'You are about to grant:',
            grantCapabilitiesPrefix: 'Grant capabilities to',
            grantCapabilitiesSuffix:
                '. The agent uses its own identity — no token is created.',
            done: 'Done'
        },
        a2aGrant: {
            addCaller: 'Add caller',
            addTarget: 'Add target',
            callerDescription: 'Authorize who can call this agent over A2A.',
            targetDescription: 'Authorize this agent to call another of your agents.',
            creating: 'Creating…',
            createToken: 'Create token',
            granting: 'Granting…',
            grantSelected: 'Grant selected ({{count}})',
            authorizeSelected: 'Authorize selected ({{count}})',
            done: 'Done',
            cancel: 'Cancel',
            copied: 'Copied',
            copy: 'Copy',
            bearerNotice:
                'Copy this token now — it is shown only once. Use it as a Bearer token against the RPC endpoint below.',
            bearerToken: 'Bearer token',
            rpcEndpoint: 'RPC endpoint',
            expires: 'Expires {{date}}.',
            neverExpires:
                'This token does not expire — revoke it from the callers list when you are done.',
            agentPeers: 'Agent peers',
            externalClient: 'External client',
            nameOptional: 'Name (optional)',
            expiryOptional: 'Expires in days (optional)',
            expiryPlaceholder: 'never',
            namePlaceholder: 'e.g. zapier-integration',
            externalDescription:
                'Creates a bearer token for an external client or SDK to call this agent. The token is shown once.',
            expiryError: 'Expiry must be a positive number of days.',
            selectAgent: 'Select at least one agent.',
            authorizeFailed: 'Could not authorize: {{names}}'
        },
        quotaConflict: {
            activeHoursUsed: 'Active hours used up',
            storageLimit: 'Storage limit reached',
            planLimit: 'Plan limit reached',
            close: 'Close',
            viewPlans: 'View plans',
            concurrentTitle: 'Concurrent active limit reached',
            concurrentBody:
                'To start {{name}}, stop one of the currently running agents.',
            noRunningAgents: 'No running agents to stop.',
            stopAndStart: 'Stop & start',
            stopping: 'Stopping {{name}}…',
            starting: 'Starting {{name}}…',
            stopTimeout:
                "{{name}} didn't stop in time. It will free its slot shortly once idle — try again in a moment."
        },
        rename: {
            title: 'Rename agent',
            ariaLabel: 'Rename agent',
            ariaClose: 'Close',
            hint: '1–{{max}} characters. You can use any language, emoji, spaces, _ - .',
            cancel: 'Cancel',
            save: 'Save',
            saving: 'Saving…',
            chatTitle: 'Rename session title',
            chatHint: 'Up to {{max}} characters. Shown in the sidebar.',
            channelTitle: 'Rename channel display',
            channelHint:
                'The display label shown for this channel session (🏷️). Clear it to fall back to the session title.'
        },
        channels: {
            larkLongConnectionHint:
                'The API holds a persistent connection to {{platform}} — no public URL or callback config needed. In Open Platform, set Event Subscriptions → Subscription Method → Long Connection.',
            larkQuick: {
                modeQr: 'Quick create',
                modeManual: 'Manual setup',
                recommended: 'Recommended',
                botNameLabel: 'Bot name',
                start: 'Generate QR code',
                scanHint:
                    'Scan with Feishu or Lark to create and connect the bot. The app secret stays on the server.',
                copyLink: 'Copy link',
                copied: 'Copied',
                waiting: 'Waiting for confirmation…',
                creating: 'Creating channel…',
                denied: 'Authorization was denied. Generate a new QR code to try again.',
                expired:
                    'This QR code expired. Generate a new one to continue.',
                retry: 'Generate again',
                createFailed:
                    'The app was created, but Manyfold could not create the channel. Generate a new QR code to retry.',
                unavailable:
                    'Quick create is temporarily unavailable. Try again or use manual setup.'
            },
            weixinQuick: {
                modeQr: 'Scan to connect',
                modeManual: 'Paste token',
                recommended: 'Recommended',
                start: 'Generate QR code',
                scanHint:
                    'Scan with WeChat to authorize the bot. The bot token stays on the server. Direct messages only.',
                waiting: 'Waiting for scan…',
                verifyPrompt: 'Enter the number shown in WeChat to continue.',
                verifySubmit: 'Submit',
                creating: 'Creating channel…',
                denied: 'Too many incorrect codes. Generate a new QR code to try again.',
                alreadyBound:
                    'This WeChat bot is already connected to a channel.',
                expired:
                    'This QR code expired. Generate a new one to continue.',
                retry: 'Generate again',
                createFailed:
                    'Authorized, but Manyfold could not create the channel. Generate a new QR code to retry.',
                unavailable:
                    'Scan to connect is temporarily unavailable. Try again or paste a token.'
            },
            whatsappQuick: {
                start: 'Generate QR code',
                scanHint: 'On your phone, open WhatsApp → Linked devices → Link a device, then scan this code.',
                waiting: 'Waiting for scan…',
                creating: 'Creating channel…',
                numberWarning: 'Use a number you can dedicate to this agent. Linking runs through WhatsApp Web, which Meta does not officially support for bots, so the number carries a ban risk.',
                alreadyBound: 'This WhatsApp number is already connected to a channel.',
                expired: 'This QR code expired. Generate a new one to continue.',
                retry: 'Generate again',
                createFailed: 'Linked, but Manyfold could not create the channel. Generate a new QR code to retry.',
                unavailable: 'Scan to connect is temporarily unavailable. Try again shortly.'
            },
            settings: {
                channels: 'Channels', newChannel: 'New channel', create: 'Create',
                backToChannels: 'Back to channels', more: 'More', docs: 'Docs', refresh: 'Refresh', edit: 'Edit',
                changeAgent: 'Change agent', changingAgent: 'Changing…', activate: 'Activate', pause: 'Pause', test: 'Test', delete: 'Delete',
                registerTelegram: 'Re-register webhook', refreshBotIdentity: 'Refresh bot identity', registerApp: 'Register app', registerToken: 'Register token',
                inboundWebhookUrl: 'Inbound webhook URL', statusLabel: 'Status', lastConnected: 'Last connected', lastError: 'Last error', recentDeliveries: 'Recent deliveries',
                lastDeliveries: 'last {{count}}', setupDocs: 'Setup docs', loadingAgents: 'Loading agents…', currentAgent: '{{name}} (current)',
                collapseAll: 'Collapse all', expandAll: 'Expand all', clearAgentFilter: 'Clear agent filter',
                agentFilter: 'Agent: {{name}}', deleteConfirmTitle: 'Delete channel', deleteConfirmDescription: 'Inbound traffic for this channel will stop.',
                changeAgentDescription: 'Route new messages on this channel to a different agent.',
                changeAgentWarning: 'Every chat starts a fresh conversation with the new agent. Existing sessions are archived — their history stays under {{name}} — and automations of other agents that deliver through this channel stop delivering.',
                editChannel: 'Edit channel', editDescription: 'Changes hot-reload the connection.',
                status: { active: 'Active', paused: 'Paused', error: 'Error', draft: 'Draft' },
                groupBy: { none: 'None', platform: 'Platform', agent: 'Agent', status: 'Status' },
                fields: {
                    agent: 'Agent', provider: 'Provider', label: 'Label', botToken: 'Bot token', botTokenKeep: 'Bot token (leave blank to keep existing)',
                    signingSecret: 'Signing secret', signingSecretKeep: 'Signing secret (leave blank to keep existing)', subscriptionMode: 'Subscription mode',
                    appId: 'App ID', appIdKeep: 'App ID (leave blank to keep existing)', appSecret: 'App Secret', appSecretKeep: 'App Secret (leave blank to keep existing)',
                    verificationToken: 'Verification Token', encryptKey: 'Encrypt Key', botName: 'Bot Name', botNameMention: 'Bot Name (for @-mention detection)',
                    allowedUserIds: 'Allowed user IDs (comma-separated)', allowedUserIdsOptional: 'Allowed user IDs (comma-separated, optional)', operatorUserIds: 'Operator user IDs (comma-separated)', operatorUserIdsOptional: 'Operator user IDs (comma-separated, optional)',
                    allowedOpenIdsOptional: 'Allowed user IDs (open_id, comma-separated, optional)', operatorOpenIdsOptional: 'Operator user IDs (open_id, comma-separated, optional)',
                    allowedGroupChatIdsOptional: 'Allowed group chat IDs (comma-separated, optional)', allowedGuildIds: 'Allowed guild IDs (comma-separated)', allowedGuildIdsOptional: 'Allowed guild IDs (comma-separated, optional)',
                    clientId: 'Client ID', clientSecret: 'Client secret', webhookSigningSecret: 'Webhook signing secret', accessToken: 'Access token', accessTokenOptional: 'Access token (optional)',
                    clientIdKeep: 'Client ID (leave blank to keep existing)', clientSecretKeep: 'Client secret (leave blank to keep existing)', webhookSigningSecretKeep: 'Webhook signing secret (leave blank to keep existing)', accessTokenKeep: 'Access token (leave blank to keep existing)', accessTokenOverride: 'Access token (optional, overrides the client pair)',
                    allowedLinearUserIdsOptional: 'Allowed Linear user IDs (comma-separated, optional)', repositoriesOptional: 'Repositories (comma-separated, optional)', allowedRoomIds: 'Allowed room IDs (comma-separated)', allowedRoomIdsOptional: 'Allowed room IDs (comma-separated, optional)', freeResponseRoomIds: 'Free-response room IDs (comma-separated)', freeResponseRoomIdsOptional: 'Free-response room IDs (comma-separated, optional)', homeserverUrl: 'Homeserver URL', ilinkBotToken: 'iLink bot token', ilinkBotTokenKeep: 'iLink bot token (leave blank to keep existing)', gatewayBaseUrlOptional: 'Gateway base URL (optional)',
                    progress: 'Progress', progressMode: 'Progress mode', replyRendering: 'Reply rendering', streamingUpdates: 'Streaming updates', historyBackfillLimit: 'History backfill limit (1-100 messages)', privateKeyKeep: 'Private key PEM (leave blank to keep existing)', webhookSecretKeep: 'Webhook secret (leave blank to keep existing)', allowedGithubLoginsOptional: 'Allowed GitHub logins (comma-separated, optional)', operatorGithubLoginsOptional: 'Operator GitHub logins (comma-separated, optional)', allowedAssociations: 'Allowed author associations (comma-separated)', delegationLabelOptional: 'Delegation label (optional)',
                    channelSecret: 'Channel secret', channelSecretKeep: 'Channel secret (leave blank to keep existing)', channelAccessToken: 'Channel access token', channelAccessTokenKeep: 'Channel access token (leave blank to keep existing)', allowedLineChatIdsOptional: 'Allowed group / room IDs (comma-separated, optional)'
                },
                options: {
                    webhook: 'Webhook (HTTP) — requires public URL', websocket: 'WebSocket (long connection) — no public URL', renderAuto: 'Auto — card when the reply contains markdown', renderText: 'Text — always plain text', renderCard: 'Card — always an interactive card', streamingPatch: 'Patch — replace the progress card per update', streamingCardkit: 'Cardkit — native typewriter streaming (needs cardkit scope)', activity: 'Activity', finalOnly: 'Final only', previewComment: 'Preview (live-edited comment)', activityPreview: 'Activity (preview + tool activity)', progressiveCards: 'Progressive cards (live updates)', activityProgress: 'Activity (tools + progress in live preview)', finalText: 'Final text only'
                },
                behaviors: {
                    attachFiles: 'Attach files the agent links', backfillChat: 'Backfill chat history on mention', backfillRoom: 'Backfill room history on mention', backfillChannel: 'Backfill channel history on mention',
                    attachFilesLarkDescription: 'When the agent links a workspace file (e.g. a generated image) in its reply, upload it to Feishu/Lark.', attachFilesSlackDescription: 'When the agent links a workspace file (e.g. a generated image) in its reply, upload it to Slack.', attachFilesDiscordDescription: 'When the agent links a workspace file (e.g. a generated image) in its reply, attach it to the message.', attachFilesMatrixDescription: 'When the agent links a workspace file (e.g. a generated image) in its reply, upload it to the Matrix room.', attachFilesWeixinDescription: 'When the agent links a workspace file (e.g. a generated image) in its reply, upload it to the WeChat chat.',
                    backfillChatDescription: 'When mentioned in a group, include recent messages since the last reply as context. Requires the conversation-history read scope.', backfillRoomDescription: "When mentioned, prepend recent Matrix room or thread messages the agent didn't see as background context.", backfillChannelDescription: "When mentioned, prepend recent channel messages the agent didn't see (mention-gated chatter) as background context.",
                    autoJoinInvites: 'Auto-join invites', autoJoinInvitesDescription: 'Join allowed invited rooms automatically.', autoThreadGroup: 'Auto-thread group replies', autoThreadGroupDescription: 'Start Matrix thread replies for group messages that are not already threaded.', autoThreadChannel: 'Auto-thread channel replies', autoThreadChannelDescription: 'Reply in a thread on the triggering message when a channel mention is not already in a thread. Requires thread isolation.', autoThreadServer: 'Auto-thread server replies', autoThreadServerDescription: 'Start a public thread from the triggering message when a server message is not already in a thread.',
                    ackReaction: 'React with 👀 while working', ackReactionDescription: 'Add a 👀 reaction to the triggering message while the agent works, cleared when the reply is done. Typing status is always shown.', finalNewMessage: 'Post the final reply as a new message', finalNewMessageTelegramDescription: 'Delete the streaming preview and send the final answer as a fresh message so Telegram fires a push notification (edited messages never notify).', finalNewMessageDiscordDescription: 'Delete the streaming preview and send the final answer as a fresh message so Discord fires a push notification.', usageFooter: 'Append a usage footer to replies', usageFooterDescription: 'Add a one-line summary (model · tokens · cost · duration · tools) to the end of each reply.',
                    githubFreshComment: 'Post the final reply as a fresh comment', githubFreshCommentDescription: 'GitHub never notifies on comment edits; a fresh comment replaces the preview and triggers notifications for watchers.', mentionOnly: 'Mention only (groups)', mentionOnlyDescription: 'Only respond when @mentioned in group chats.', shareSession: 'Share session in channel', shareSessionDescription: 'All group members share one chat session (otherwise per-user).', threadIsolation: 'Thread isolation', sendContext: 'Send message context to the agent', sendContextDescription: 'Prepend channel metadata (sender, message IDs) to each inbound message so the agent knows who sent it.', sendContextFullDescription: 'Prepend channel metadata (sender, chat, thread, message IDs) to each inbound message so the agent knows who sent it and from where.'
                },
                threadLabels: { lark: 'Each message thread gets its own session.', telegram: 'Each Telegram topic or reply thread gets its own session.', slack: 'Each Slack thread gets its own session.', discord: 'Each Discord thread gets its own session; replies stay in the thread.', matrix: 'Each Matrix thread gets its own session. Without an existing Matrix thread, auto-thread can start one from the incoming event.' },
                connection: { sync: 'Sync (long-poll)', gateway: 'Gateway (WebSocket)', ilink: 'iLink (long-poll)', websocket: 'WebSocket (long connection)' },
                connectionHelp: { matrix: 'The API polls Matrix /sync with the bot access token — no public URL or callback config needed. Encrypted rooms are unsupported; encrypted events are dropped.', discord: 'The API holds a Discord Gateway connection — no public URL or callback config needed. Make sure MESSAGE_CONTENT is enabled in the Developer Portal under Bot → Privileged Gateway Intents.', weixin: 'The API long-polls the Tencent iLink bot gateway with the bot token — no public URL needed. Personal WeChat is direct-message only; group chats are not delivered. If the session expires (errcode -14), re-scan the QR code and update the token.' },
                webhookHelp: { telegram: 'Telegram webhook is registered automatically when credentials are saved — nothing to paste.', slack: 'Paste this URL into your Slack app under Event Subscriptions → Request URL.', lark: 'Paste this into {{platform}} Open Platform → Event Subscriptions → Request URL.', github: 'The Create GitHub App flow sets this webhook URL on the app automatically; for a hand-created app, set it as the app webhook URL with the issues and issue_comment events.', line: 'The LINE webhook URL is set automatically when credentials are saved — nothing to paste. Turn on "Use webhook" in the LINE Developers console under Messaging API, and turn off Auto-reply messages there so the bot does not answer twice.', other: 'Paste this URL into your provider event subscription configuration.' },
                github: { title: 'GitHub App', connectedAs: 'Connected as', mentionHint: '. Mention it in an issue or comment to start a turn.', install: 'Install on repositories', installHint: 'The app must be installed on every repository the agent should answer on. Repo write access (clone/push/PR) comes from a GitHub Connection linked to the same agent, not from this app.', createHint: 'Create a dedicated GitHub App for this channel — GitHub sends the credentials back automatically and the channel activates itself. Leave the organization empty to create it on your personal account.', create: 'Create GitHub App' },
                slack: { manifest: 'Slack app manifest', copyManifest: 'Copy manifest JSON', manifestHint: 'Create the Slack app from a manifest and paste this JSON. It wires the Request URL, event subscriptions, bot scopes, and all slash commands for this channel. If another installed app already claims a command name (e.g.', manifestHintSuffix: '), Slack warns at install — rename it in the manifest first. Invite the bot to each channel so it can post.' },
                delivery: { when: 'When', direction: 'Direction', scope: 'Scope', summary: 'Summary' },
                deliveryDirection: { inbound: 'Inbound', outbound: 'Outbound' },
                deliveryStatus: { sent: 'Sent', accepted: 'Accepted', dropped: 'Dropped', failed: 'Failed' },
                tooltips: { reregisterTelegram: 'Re-run setWebhook on Telegram', refreshLarkIdentity: 'Fetch the bot identity used for @-mention detection', registerWeixin: 'Verify the iLink bot token and activate the channel', registerLinear: 'Mint an app token, capture the Linear identity, and activate the channel', registerGithub: 'Verify the app credentials, capture the app identity, and activate the channel', registerMatrix: 'Verify Matrix whoami and activate the channel', registerLine: 'Set the webhook URL on LINE, capture the bot identity, and activate the channel' },
                placeholders: { teamSupport: 'e.g. team-support', linearClientId: 'from your Linear application', linearAccessToken: 'paste a token instead of a client pair', organizationOptional: 'organization (optional)', privateKey: '-----BEGIN RSA PRIVATE KEY----- (or base64 of it)', delegationLabel: 'e.g. agent' },
                setupMode: { lark: 'Lark setup mode', weixin: 'WeChat setup mode' },
                help: { telegramCreate: 'Create a bot via @BotFather and paste the token. We will register the webhook on your behalf.', telegramEdit: 'Leave allowed users or group chats empty to allow anyone. Operators can run agent-wide commands like /model; with no operators, those commands are disabled from Telegram.', slackCreate: 'After saving, paste the channel inbound URL into your Slack app under Event Subscriptions. Leave allowed users empty to let anyone in the workspace use the bot. Operators can run agent-wide commands like /model; with no operators, /model is disabled from Slack.', slackEdit: 'Leave allowed users empty to let anyone in the workspace use the bot. Operators can run agent-wide commands like /model; with no operators, /model is disabled from Slack.', linearCreate: 'Create an application in your Linear workspace, enable webhooks with Agent session events, and paste the channel inbound URL there after saving. Client credentials let Manyfold mint its own app token; supply an access token instead if you minted one yourself. Leave allowed users empty to let anyone in the workspace mention the agent.', githubCreate: 'Create the channel first, then use “Create GitHub App” on its page — GitHub sends the app credentials back automatically. Mention the app on an issue to start a turn. Leave repositories empty to answer on every repository the app is installed on.', discordCreate: "Discord uses a Gateway WebSocket — no public URL needed. Enable the MESSAGE_CONTENT intent in the Developer Portal under Bot → Privileged Gateway Intents, otherwise the bot won't see message text.", matrixCreate: 'Matrix uses /sync long-polling — no webhook URL is needed. Encrypted rooms are unsupported; encrypted events are dropped.', weixinCreate: 'Personal WeChat via the Tencent iLink bot gateway — direct messages only, no webhook URL needed. Leave operator IDs empty to disable agent-wide commands.', larkManual: 'Leave allowed users empty to let anyone reach the bot. Operators can run agent-wide commands like /model; with no operators, /model is disabled from Feishu/Lark.', weixinEdit: 'Personal WeChat is direct-message only. Leave operator IDs empty to disable agent-wide commands (e.g. /model).', whatsappEdit: 'WhatsApp links through WhatsApp Web, so this channel needs no webhook URL. Leave allowed senders or group chats empty to allow anyone. Operators can run agent-wide commands like /model; with no operators, those commands are disabled from WhatsApp. Senders may be written as a phone number or a raw jid.', linearEdit: 'Activity shows thinking, tool calls and the plan on the Linear session as the agent works; Final only posts the result. Rotating credentials replaces all of them at once, so re-enter the signing secret with any change.', githubEdit: 'Empty allowed logins fall back to the association gate (repo owner, org members and collaborators by default — add NONE to open it up). Adding the delegation label to an issue starts a turn without a mention. Leave operator logins empty to disable agent-wide commands (e.g. /model).', lineCreate: 'Create a Messaging API channel in the LINE Developers console, issue a long-lived channel access token, and paste both here. We set the webhook URL for you — you still have to turn on "Use webhook" in the console. Replies are plain text with no live preview, and each one counts against your LINE plan\'s message quota.', lineEdit: 'Leave allowed users or group IDs empty to allow anyone. Operators can run agent-wide commands like /model; with no operators, those commands are disabled from LINE. Rotating credentials replaces both at once, so re-enter the channel secret and the access token together.' },
                errors: { larkWebhookCredentials: 'Lark/Feishu webhook channels require a Verification Token or Encrypt Key.', linearCredentials: 'Linear needs either an access token, or both a client ID and client secret', matrixHomeserver: 'Matrix homeserver URL is required.', matrixAccessToken: 'Matrix access token is required.', slackCredentials: 'Slack token rotation requires both Bot token and Signing secret.', linearRotation: 'Linear credential rotation needs the webhook signing secret plus either an access token, or both a client ID and client secret.', githubRotation: 'GitHub credential rotation needs the App ID, private key and webhook secret together.', weixinBotToken: 'WeChat iLink bot token is required.', lineCredentials: 'LINE needs both a channel secret and a channel access token.', lineRotation: 'LINE credential rotation needs the channel secret and the channel access token together.', unsupportedProvider: 'Unsupported channel provider: {{provider}}.' }
            }
        },
        quota: {
            storageWarning:
                "You're at {{pct}}% of your {{plan}} plan's storage ({{used}} GB / {{max}} GB). Archive unused agents or upgrade.",
            provisionedWarning:
                "You're at {{pct}}% of your {{plan}} plan's provisioned sandbox limit ({{used}} / {{max}}). Reuse or delete an unused sandbox, or upgrade.",
            concurrentWarning:
                "You're at {{pct}}% of your {{plan}} plan's concurrent active limit ({{used}} / {{max}}). Stop an agent to free a slot.",
            wholesaleWarning:
                'Wholesale capacity is at {{pct}}% ({{used}} / {{max}} active sandboxes org-wide). Consider raising the cap.',
            activeHoursWarning:
                "You're at {{pct}}% of your {{plan}} plan's included active hours ({{used}}h / {{max}}h this billing period). Over the limit, sandbox activity pauses until upgrade or next period.",
            channelsWarning:
                "You're using {{used}} of the {{max}} channels on your {{plan}} plan. Connecting another will be blocked until you disconnect one or upgrade.",
            automationsWarning:
                "You're using {{used}} of the {{max}} automations on your {{plan}} plan. Creating another will be blocked until you delete one or upgrade.",
            automationRunsWarning:
                "You're at {{pct}}% of your {{plan}} plan's automation runs ({{used}} / {{max}} this billing period). Over the limit, scheduled runs stop until upgrade or next period.",
            apiRequestsWarning:
                "You're at {{pct}}% of your {{plan}} plan's API requests ({{used}} / {{max}} this billing period). Over the limit, API calls are rejected until upgrade or next period."
        },
        terminal: {
            statusConnecting: 'Connecting',
            statusOpen: 'Open',
            statusClosed: 'Closed',
            statusError: 'Error',
            resizePanel: 'Resize terminal panel',
            closeTab: 'Close terminal',
            closeTabAria: 'Close terminal {{index}}',
            openAnother: 'Open another terminal',
            minimize: 'Minimize terminal panel',
            restore: 'Restore terminal panel',
            closePanel: 'Close terminal panel',
            noAuthToken: 'No auth token',
            wsError: 'WebSocket error',
            reconnect: 'Reconnect',
            limitedPty:
                'Limited terminal — no resize or job control. Update the CLI on this computer to enable full terminal support.',
            enablePromptTitle: 'Enable terminal?',
            enablePromptBody:
                'The terminal is turned off for this sandbox. Enable it to open an interactive shell. You can turn it off again anytime in the sandbox settings.',
            enablePromptConfirm: 'Enable terminal',
            enablePromptCancel: 'Cancel',
            unavailableExternal:
                'This agent runs on an external provider, so it has no terminal.',
            unavailableStopped: 'Start the agent to open its terminal.'
        },
        sessionView: {
            switchToTerminal: 'Switch to TUI',
            switchToChat: 'Switch to Chat UI',
            resumeNeedsCredentials:
                'This is a plain shell: resuming the conversation here needs model credentials in the terminal, which is off for this sandbox.',
            resumeNeedsSignIn:
                'This is a plain shell: resuming the conversation here needs the coding CLI to be signed in on this runtime.',
            resumeNeedsDaemonUpgrade:
                'This is a plain shell: resuming the conversation here needs a newer Manyfold CLI on this computer.'
        },
        composer: {
            askPlaceholder: 'Ask {{target}} anything.',
            chatAdapterPending: 'chat adapter pending',
            theAgent: 'the agent',
            agentLabel: 'Agent',
            selectAgent: 'Select agent',
            openActions: 'Open composer actions',
            addPhotosFiles: 'Add photos & files',
            changePermissions: 'Change {{framework}} permissions',
            permissionsHeading: 'How should {{framework}} approve actions?',
            dangerousPermissionTitle: 'Enable “{{mode}}”?',
            dangerousPermissionDescription:
                '{{framework}} will run without permission prompts or safety checks. Only use this in a trusted, sandboxed environment.',
            dangerousPermissionConfirm: 'Enable',
            changeModel: 'Change model',
            agentContext: 'Agent context',
            switchAgent: 'Switch agent',
            stopResponse: 'Stop response',
            sendMessage: 'Send message',
            sendHint: 'Send (Cmd/Ctrl+Enter)',
            streaming: 'Streaming',
            modelMenuLabel: 'Change model',
            modelFilterPlaceholder: 'Filter models…',
            modelNoMatches: 'No models match',
            modelDefaultLabel: 'Default ({{model}})',
            modelSettings: 'Model settings',
            modelSelectedTitle: '{{model}} (selected for this chat)',
            modelDefaultTitle: 'Default: {{model}}',
            modelManagedBy:
                '{{base}}; model switching is managed by {{framework}}',
            uploaded: 'Uploaded',
            removeAttachment: 'Remove {{name}}',
            attachmentFallbackName: 'attachment',
            folderContext: 'Folder context',
            fileContext: 'File context',
            attachmentLimit:
                'Attach up to {{max}} files or context refs per message.',
            fileTooLarge: 'File exceeds {{size}}.',
            attachmentsTooLarge: 'Attachments exceed {{size}} total.',
            cannotUpload: 'Unsupported file type.',
            attachmentDropHint: 'Drop files to attach',
            refreshing: 'Refreshing…',
            refresh: 'Refresh',
            runtimeLocalUsingTitle: 'Runtime local config',
            validation: {
                testProvider: 'Test this provider in Source to load its models',
                configureClaudeMapping: 'Configure Claude model mapping',
                chooseTestedClaudeModel: 'Choose a tested Claude model',
                useTestedProviderModels:
                    'Use tested provider models for Claude mapping',
                chooseSupportedCodexModel: 'Choose a supported Codex model',
                chooseFastCapableModel: 'Choose a fast-capable model',
                chooseSupportedGeminiModel: 'Choose a supported Gemini model',
                runtimeLocalNotReady:
                    'The local config on this runtime is not ready'
            },
            configure: 'Configure',
            permission: {
                claude: {
                    ask: 'Ask permissions',
                    askTitle: 'Use the Claude Code configured default permission mode',
                    askDescription: 'Ask before edits and commands',
                    acceptEdits: 'Accept edits',
                    acceptEditsTitle: 'Allow Claude Code to make file edits',
                    acceptEditsDescription: 'Auto-apply edits, ask for commands',
                    plan: 'Plan mode',
                    planTitle: 'Have Claude Code plan before making changes',
                    planDescription: 'Plan only, no changes',
                    auto: 'Auto mode',
                    autoTitle: 'Let Claude Code automatically choose permission behavior',
                    autoDescription: 'Run automatically with guardrails',
                    dontAsk: "Don't ask",
                    dontAskTitle: 'Run Claude Code without asking for permissions',
                    dontAskDescription: 'No prompts, deny rules still apply',
                    bypass: 'Bypass permissions',
                    bypassTitle: 'Run Claude Code without permission prompts',
                    bypassDescription: 'No prompts or safety checks'
                },
                codex: {
                    ask: 'Ask for approval',
                    askTitle: 'Use the Codex configured default permission settings',
                    askDescription: 'Ask before edits and internet access',
                    approve: 'Approve for me',
                    approveTitle: 'Allow workspace edits with Codex sandboxing enabled',
                    approveDescription: 'Only ask for risky actions',
                    full: 'Full access',
                    fullTitle: 'Run Codex without approvals or sandboxing',
                    fullDescription: 'Unrestricted internet and file access'
                },
                hermes: {
                    ask: 'Ask for approval',
                    askTitle: 'Ask before file edits and risky commands',
                    askDescription: 'Approval cards appear in the chat',
                    acceptEdits: 'Accept edits',
                    acceptEditsTitle:
                        'Auto-allow workspace edits; still asks for risky commands',
                    acceptEditsDescription: 'Sensitive paths still ask',
                    dontAsk: "Don't ask",
                    dontAskTitle: 'Run Hermes without approval prompts',
                    dontAskDescription: 'Everything is auto-approved'
                }
            },
            ready: 'Ready',
            readyModels: 'Ready · {{count}} models',
            notChecked: 'Not checked',
            config: 'Config',
            cli: 'CLI',
            checked: 'Checked',
            notCheckedYet:
                'Not checked yet — use “Refresh” above to read the agent\'s CLI config.',
            chooseModel: 'Choose model',
            default: 'Default',
            models: 'Models',
            model: 'Model',
            effort: 'Effort',
            reasoning: 'Reasoning',
            speed: 'Speed',
            intelligence: {
                low: 'Low',
                medium: 'Medium',
                high: 'High',
                xhigh: 'Extra high',
                max: 'Maximum',
                unknown: 'Unknown'
            },
            speedLabels: {
                fast: 'Fast',
                standard: 'Standard',
                unknown: 'Unknown'
            },
            modelOptions: '{{count}} options',
            supportedCodexModel: 'Choose a supported Codex model',
            fastUnavailable: 'Fast is only available for GPT-5.5 and GPT-5.4',
            fastDescription: '1.5x speed, increased usage',
            standardSpeedDescription: 'Default speed, normal usage'
        },
        credentials: {
            heading: 'Model provider',
            loading: 'Loading model provider…',
            comingSoon: 'Coming soon',
            notAvailable:
                'Model provider configuration for {{framework}} agents is not yet available.',
            provider: 'Provider',
            change: 'Change',
            model: 'Model',
            frameworkDefault: 'Optional framework default',
            useFrameworkDefault: 'Use framework default',
            placeholderSaved:
                'Test the saved provider in Settings to enable a dropdown',
            placeholderUnsaved: 'Select a saved provider, or type a model id',
            saving: 'Saving…',
            modelsCount: '{{count}} models',
            modelSourceLabel: 'Model source',
            modelSourcePlatform: 'Manyfold',
            modelSourcePlatformHint: 'Use the provider and model set here',
            modelSourceLocal: 'Local config',
            modelSourceLocalHint: "Use the agent's own CLI config",
            runtimeLocal: {
                credentialsExpired:
                    'The sign-in on this runtime has expired. Sign in again there, then refresh.',
                credentialsMissing:
                    'No sign-in was found on this runtime. Sign in there, then refresh.',
                cliDefault: 'CLI default',
                modelsFrom: 'Models from the local CLI config',
                pickModel: 'Select a local model'
            },
            claudeMapping: 'Claude model mapping',
            selectProviderModel: 'Select provider model',
            effort: 'Effort',
            closeProviderMenu: 'Close provider menu',
            modelProviders: 'Model providers',
            savedProviders: 'Saved {{provider}} providers',
            noSavedProviders: 'No saved {{provider}} providers.',
            addOne: 'Add one',
            inSettings: ' in Settings.',
            currentProvider: 'Current provider',
            selectProvider: 'Select provider',
            pickSavedProvider: 'Pick a saved model provider from Settings',
            builtIn: 'Built-in',
            managed: 'Managed',
            custom: 'Custom',
            successUpdated: 'Updated.',
            successUpdatedCodex:
                'Updated. Re-logging in on the Stateful sandbox - next message will use the new key.',
            successUpdatedClaude: 'Updated. Next message will use the new key.',
            successUpdatedDefault:
                'Updated. Restarting agent — chat will resume in a few seconds.',
            providerTestFailed: 'Provider test failed',
            pickProvider: 'Pick a saved provider first.',
            testProviderBeforeSave:
                'Test the selected provider before saving model settings.',
            chooseSupportedModel: 'Choose a supported model.'
        },
        workspaceFiles: {
            filterPlaceholder: 'Filter loaded files…',
            filterAria: 'Filter loaded files',
            closeSearch: 'Close search',
            searchFiles: 'Search files',
            agentStatus: 'Agent is {{status}}.',
            retry: 'Retry',
            noFiles: 'No files in {{root}}.',
            noMatches: 'No matches for "{{query}}".',
            searchCovers: 'Search covers loaded folders.',
            loadingDir: 'Loading {{name}}…',
            failed: 'Failed {{name}}',
            retryAction: 'Retry',
            attachContext: 'Attach as context',
            copyPath: 'Copy path',
            copyRelativePath: 'Copy relative path',
            copyFilename: 'Copy filename',
            openInTerminal: 'Open in terminal',
            downloadFile: 'Download file',
            uploadFile: 'Upload file',
            resizeFilesPreview: 'Resize files and preview',
            resizePreviewFiles: 'Resize preview and files',
            hideTree: 'Hide file tree',
            showTree: 'Show file tree',
            workspaceLabel: 'Workspace',
            readOnly: 'read-only',
            previewLoading: 'Loading preview…',
            previewCloseTab: 'Close {{name}}',
            previewRaw: 'Raw',
            previewUnsupported: 'Only regular files can be previewed.',
            previewImageTooLarge:
                'Image is {{size}}, too large to preview inline.',
            previewBinary: '{{type}} is not shown inline.',
            previewBinaryFallback: 'Binary file',
            previewTextTooLarge:
                'File is {{size}}, too large to preview inline.',
            previewXlsUnsupported:
                'Legacy .xls files cannot be previewed. Use Download file instead.',
            previewRowsTruncated: 'Showing first {{count}} rows.',
            previewColsTruncated: 'Showing first {{count}} columns.',
            previewEmptyTable: 'No rows to display.',
            previewRenderError: 'Preview failed: {{message}}',
            previewCrashed:
                'Preview failed to render. The file may be malformed.',
            previewSqliteTable: 'Table',
            previewSqliteNoTables: 'No tables or views in this database.',
            previewSqliteRows: 'Rows',
            previewSqliteSchema: 'Schema',
            previewSqliteWalWarning:
                'A -wal file exists; recent writes may be missing from this preview.',
            previewInflatedTooLarge:
                'File decompresses to too much data to preview inline.',
            previewTimeout:
                'Preview timed out. The file may be too complex or malformed.',
            previewWorkerFailed: 'Preview worker failed.',
            previewDatabaseNotOpen: 'Database is not open.',
            rawToggleShowRendered: 'Show rendered preview',
            rawToggleShowRaw: 'Show raw file',
            rawToggleAlreadyRaw: 'This file is already shown raw',
            rawToggleUnavailable: 'Raw preview is unavailable for this file',
            terminalLabel: 'Terminal · {{name}}',
            directoryRoot: 'root'
        },
        account: {
            title: 'Account',
            providerEmailPassword: 'Email & password',
            providerGoogle: 'Google',
            providerSso: 'SSO',
            providerNetmind: 'NetMind',
            connect: 'Connect',
            setPassword: 'Set password',
            changePassword: 'Change password',
            changeEmail: 'Change email',
            disconnect: 'Disconnect',
            disconnectTitle: 'Disconnect {{provider}}?',
            disconnectNetmindDescription:
                "You'll no longer be able to sign in with NetMind ({{email}}). You can reconnect from this page anytime.",
            disconnectGoogleDescription:
                "You'll no longer be able to sign in with Google ({{email}}). You can reconnect from this page anytime.",
            disconnectSsoDescription:
                "You'll no longer be able to sign in with SSO ({{email}}).",
            avatarReadFailed: 'Could not read that image. Try another file.',
            avatarUpdateFailed: 'Updating the photo failed. Try again.',
            googleConnected:
                'Google account connected. You can now use it to sign in.',
            googleIdentityInUse:
                'That Google account is already linked to a different Manyfold account.',
            googleConnectFailed: 'Connecting Google failed. Try again.',
            netmindConnected:
                'NetMind account connected. You can now use it to sign in.',
            passwordUpdated: 'Password updated.',
            passwordSet:
                'Password set. You can now sign in with your email and password.',
            profilePhotoChange: 'Change photo',
            profilePhotoRemove: 'Remove photo',
            profileNamePlaceholder: 'Your name',
            emailPlaceholder: 'you@example.com',
            profileNameSave: 'Save name',
            profileNameEdit: 'Edit name',
            profileNameAdd: 'Add name',
            signInMethods: 'Sign-in methods',
            noSignInMethods: 'No sign-in methods yet.',
            onlySignInMethod:
                'Your only way to sign in. Set a password to enable disconnecting it.',
            notConnected: 'Not connected',
            noPasswordSet: 'No password set',
            connectNetmindTitle: 'Connect NetMind',
            connectNetmindDescription:
                'Sign in to your NetMind account to link it. Afterwards you can use it to sign in to Manyfold.',
            emailChanged:
                'Email changed to {{newEmail}}. {{oldEmail}} can no longer be used to sign in.',
            codeTitle: 'Enter the verification code',
            codeSent: 'We sent a 6-digit code to {{email}}.',
            codeOnWay: 'A new code is on its way.',
            codeMissing: "Didn't get it?",
            codeResend: 'Resend code',
            codeResendFailed: 'Resending the code failed. Try again.',
            codeVerifyFailed: 'Verifying the code failed. Try again.',
            verifying: 'Verifying…',
            changeEmailStartFailed:
                'Starting the email change failed. Try again.',
            changeEmailGoogleStartFailed:
                'Starting Google verification failed. Try again.',
            changeEmailCurrent: 'Your sign-in email is {{email}}.',
            changeEmailGoogleProof:
                'First confirm it’s you by verifying with the Google account linked to this Manyfold account.',
            changeEmailNeedsProof:
                'Changing your email needs a second confirmation. Set a password first, sign in with it, then change your email — or connect Google and verify with it.',
            verifyWithGoogle: 'Verify with Google',
            changeEmailDescription:
                'Replaces {{email}} as your sign-in email. We’ll send a code to the new address.',
            newEmail: 'New email',
            sameEmail: "That's already your sign-in email.",
            currentPassword: 'Current password',
            currentPasswordPlaceholder: 'Confirms it’s you',
            verifyWithGoogleFallback:
                'Can’t use your password? Verify with Google',
            newPassword: 'New password',
            passwordMinimum: 'At least {{count}} characters',
            newEmailPasswordHint: 'Your new email signs in with this password.',
            confirmPassword: 'Confirm password',
            confirmPasswordPlaceholder: 'Repeat the password',
            passwordsMismatch: "Passwords don't match.",
            sendingCode: 'Sending code…',
            sendVerificationCode: 'Send verification code',
            passwordSetFailed: 'Setting the password failed. Try again.',
            passwordCodeSendFailed: 'Sending the code failed. Try again.',
            passwordTitleChange: 'Change password',
            passwordTitleSet: 'Set password',
            passwordDescriptionChange: 'Updates the password for {{email}}.',
            passwordDescriptionSet:
                "Adds password sign-in for {{email}}. We'll send a code there to confirm.",
            savingPassword: 'Saving…',
            dangerTitle: 'Danger zone',
            deleteAccountTitle: 'Delete account',
            deleteAccountDescription:
                'Deleting your account cannot be undone once the grace period ends:',
            deleteConsequenceAgents:
                'All agents, sandboxes and their workspaces are permanently deleted.',
            deleteConsequenceBilling:
                'Subscriptions are canceled immediately, without a refund.',
            deleteConsequenceGrace:
                'The account deactivates as soon as you confirm by email; during the grace period an emailed link can still restore it.',
            deleteAccountButton: 'Delete account…',
            deleteConfirmTitle: 'Delete your account?',
            deleteConfirmDescription:
                'We will email a confirmation link to {{email}}. Nothing happens until you open it — the link expires after 24 hours.',
            deleteAwaitingTitle: 'Check your email',
            deleteAwaitingBody:
                'A confirmation link is on its way to {{email}}. Your account is only scheduled for deletion after you confirm; the link expires on {{expires}}.',
            deleteResend: 'Resend email',
            deleteResent: 'A new confirmation email is on its way.'
        },
        accountDeletion: {
            confirmTitle: 'Confirm account deletion',
            confirmBody:
                'This deactivates your account immediately: every session is signed out and subscriptions are canceled without a refund. After the grace period, the account and all of its data are permanently deleted.',
            confirmRestoreHint:
                'If you change your mind during the grace period, the email we send next contains a restore link.',
            confirmButton: 'Delete my account',
            confirmBusy: 'Confirming…',
            confirmedTitle: 'Deletion scheduled',
            confirmedBody:
                'Your account is deactivated and will be permanently deleted on {{date}}. We emailed you a restore link that works until that date.',
            restoreTitle: 'Restore your account',
            restoreBody:
                'Your account is scheduled for deletion. Restoring cancels that and reactivates it — paused automations and canceled subscriptions stay off until you re-enable them.',
            restoreButton: 'Restore my account',
            restoreBusy: 'Restoring…',
            restoredTitle: 'Account restored',
            restoredBody: 'Welcome back. You can sign in again now.',
            goToSignIn: 'Go to sign in',
            missingToken:
                'This link is incomplete. Open the exact link from the email.',
            linkInvalid: 'This link is invalid or has expired.'
        },
        updates: {
            title: 'Update Center',
            subtitle: 'Every available update across your machines, agents and skills.',
            refresh: 'Refresh',
            reviewCta: 'Review in Update Center',
            updateSelected: 'Update selected ({{count}})',
            updateOne: 'Update',
            selectAll: 'Select every update that can be run from here',
            selectRow: 'Select {{name}}',
            colUpdate: 'Update',
            colTarget: 'Where',
            colVersion: 'Version',
            colStatus: 'Status',
            colAction: 'Action',
            versionUnknown: 'Unknown',
            kindCli: 'mf CLI',
            kindFramework: 'Agent framework',
            kindSkill: 'Skill',
            kindCliUsage: 'Manyfold CLI usage',
            groupKind: 'Type',
            groupTarget: 'Where',
            groupStatus: 'Status',
            statusRequired: 'Update required',
            statusReady: 'Ready to update',
            statusManual: 'Update by hand',
            statusOffline: 'Machine offline',
            run: {
                pending: 'Queued',
                running: 'Updating',
                succeeded: 'Updated',
                failed: 'Failed',
                waiting: 'Waiting for the rate limit window'
            },
            runningNotice: 'Updates run one at a time; leaving this page stops the queue.',
            batchSummary: '{{done}} updated · {{failed}} failed',
            emptyTitle: 'Everything is up to date',
            emptyBody: 'No updates are available for your machines, agents or skills.',
            filteredNotice: 'Showing {{kind}} only',
            clearFilter: 'Show all',
            viewTarget: 'View'
        },
        usage: {
            title: 'Usage',
            overview: 'Overview',
            tokens: 'Tokens',
            cost: 'Cost',
            input: 'Input',
            output: 'Output',
            inputTokens: 'Input tokens',
            outputTokens: 'Output tokens',
            events: 'Events',
            byModel: 'By model',
            model: 'Model',
            byAgent: 'By agent',
            agent: 'Agent',
            recentEvents: 'Recent events',
            viewAllEvents: 'View all events →',
            range5Hours: '5 hours',
            range24Hours: '24 hours',
            range7Days: '7 days',
            range30Days: '30 days',
            range90Days: '90 days',
            rangeCustom: 'Custom',
            chartTooltip:
                '{{date}} · input {{input}} · output {{output}} · {{cost}}',
            eventsLoadedOne: '{{count}} event loaded',
            eventsLoadedMany: '{{count}} events loaded',
            clearFilters: 'Clear filters',
            range: 'Range',
            from: 'From',
            to: 'To',
            framework: 'Framework',
            allAgents: 'All agents',
            allFrameworks: 'All frameworks',
            loadingMore: 'Loading more…',
            loadMore: 'Load more',
            fallbackModel: 'Fallback model',
            fallbackModelBody:
                'The runtime did not report a model for this event, so a default model was assumed for pricing.',
            fallbackModelCost:
                'Its cost is estimated from a price table, not a billed amount from the provider.',
            time: 'Time',
            cacheReadWrite: 'Cache r/w',
            ttft: 'TTFT',
            estimatedCost: 'Estimated from price table'
        },
        auth: {
            unavailableTitle: 'Authentication unavailable',
            setupRequired: 'Setup required',
            adminNeedsToConfigure:
                'An administrator needs to configure authentication.',
            continueWithSso: 'Continue with SSO',
            account: 'Account',
            signInTitle: 'Sign in',
            signUpTitle: 'Create account',
            verifyEmailTitle: 'Verify email',
            useWorkspaceAccount: 'Use your workspace account.',
            createWorkspaceAccount: 'Create a workspace account.',
            emailLabel: 'Email',
            passwordLabel: 'Password',
            verificationCodeLabel: 'Verification code',
            continueWithGoogle: 'Continue with Google',
            continueWithNetmind: 'Continue with NetMind',
            orUseEmail: 'or continue with email',
            pleaseWait: 'Please wait...',
            createAccount: 'Create an account',
            useExistingAccount: 'Use an existing account',
            errorAuthFailed: 'Authentication failed',
            forgotPasswordCta: 'Forgot password?',
            forgotPasswordTitle: 'Reset your password',
            forgotPasswordBody:
                'Enter your email and we will send a reset code.',
            sendResetCode: 'Send reset code',
            resetPasswordTitle: 'Set a new password',
            resetPasswordBody:
                'Enter the code from your email and a new password.',
            newPasswordLabel: 'New password',
            resetPasswordCta: 'Update password',
            checkYourEmailBody: 'We sent you a verification code.',
            resendCodeCta: 'Resend code',
            codeResent: 'A new code is on its way.',
            backToSignIn: 'Back to sign in',
            oauthError: 'Sign-in could not be completed. Please try again.',
            netmindDefaultDescription: 'Sign in with your NetMind account.',
            netmindBindPrompt:
                'One more step — verify your email to finish linking this NetMind account.',
            netmindEmailLabel: 'NetMind email',
            netmindPasswordLabel: 'NetMind password',
            netmindPasswordPlaceholder: 'Your NetMind password',
            netmindCodePlaceholder: 'Code from the email we sent you',
            netmindConfirm: 'Confirm',
            netmindConnecting: 'Connecting…',
            netmindOrContinueWith: 'or continue with',
            netmindMethodNote:
                'Uses the sign-in method of your NetMind account, not a new one for Manyfold.'
        },
        agentNew: {
            title: 'Create Agent',
            status: 'Status',
            offline: 'Offline',
            cancel: 'Cancel',
            completed: 'Completed',
            framework: 'Framework',
            frameworkDesc:
                "What kind of agent. We'll narrow the runtime + model options below to match.",
            runtime: 'Runtime',
            runtimePending:
                'Pick a framework first — runtime options depend on it.',
            runtimeDescAttached:
                'Attached to an existing runtime — provider and credentials are inherited.',
            runtimeDescDefault:
                'Where it executes. Sandbox is the fast default for code agents.',
            sandbox: 'Sandbox',
            sandboxDesc: 'Stateful, ephemeral container. Best for code edits.',
            persistent: 'Cloud computer',
            persistentDescK8s:
                '{{framework}} needs a cloud computer. Rent one via Plan & Billing.',
            persistentDescDefault:
                'Long-running cloud computer. Rent via Plan & Billing.',
            persistentRent: 'Rent a cloud computer →',
            localDaemon: 'Self-owned computer',
            localDaemonRegister: 'Add a self-owned computer →',
            orAttachExisting: 'Or attach to an existing runtime',
            availableCount: '{{count}} available',
            cloneProfile: 'Clone an existing profile',
            loadingProfiles: 'Loading profiles…',
            sourceProfile: 'Source profile',
            noProfilesToClone: 'No profiles to clone from on this runtime.',
            providerPending:
                'Pick a runtime first — provider options depend on it.',
            providerPendingNoFw:
                'Where we get model credits. Available after the framework is set.',
            provider: 'Provider',
            providerDescExternal:
                'Pick the external provider configured in Settings → External agents.',
            providerDescInherited:
                'Provider is inherited from the selected runtime.',
            providerDescNew:
                'Where we get model credits. Pick a saved provider or paste an API key.',
            noExternalProviders: 'No external providers yet —',
            createOneLink: 'create one',
            firstSuffix: 'first.',
            pickAProvider: 'Pick a provider…',
            usingCredentialsFrom: 'Using credentials from',
            apiProvider: 'API provider',
            baseUrlOptional: 'Base URL (optional)',
            primaryModel: 'Primary model',
            primaryModelPlaceholder: 'e.g. anthropic/claude-sonnet-5',
            nameWorkspace: 'Name & workspace',
            nameWorkspacePendingDesc:
                'Name and (for code agents) the folder it operates on.',
            nameWorkspacePendingDesc2: 'Configure the provider first.',
            nameWorkspaceDesc:
                'Give the agent a name and the workspace path it operates on.',
            nameWorkspaceDescNoWs: 'Display name for this agent.',
            agentName: 'Agent name',
            agentNamePlaceholder: 'witty-cat-0042',
            random: 'Random',
            workspacePath: 'Workspace path (optional)',
            whatWillBeCreated: 'What will be created',
            livePreview: 'Live preview',
            live: 'Live',
            percentComplete: '{{percent}}% complete',
            fillRemaining: 'fill remaining fields',
            ready: 'ready',
            notPicked: 'not picked',
            required: 'required',
            notSet: 'not set',
            workspace: 'Workspace',
            clonedFrom: 'Cloned from',
            selectProfile: 'select profile',
            equivalentCli: 'Equivalent CLI',
            creating: 'Creating…',
            createAgent: 'Create agent →',
            loadingProviderModels: 'Loading provider models…',
            hintPickFramework: 'Pick a framework above to get started.',
            hintExternalReady: 'Ready to create.',
            hintExternalFinishFields:
                'Finish remaining fields to enable Create.',
            hintExternalPickProvider: 'Pick an external provider to continue.',
            hintRuntime: 'Pick a runtime to continue.',
            hintProvider: 'Configure a provider to unlock the next step.',
            hintName: 'Give the agent a name.',
            hintResolve: 'Resolve the highlighted fields to enable Create.',
            creatingTitle: 'Creating',
            creatingFailed:
                'Something went wrong while provisioning the runtime.',
            creatingNormal:
                "Usually takes 10–15 seconds. You can wait here or come back later — we'll notify you.",
            provisioningHalted:
                'Provisioning halted at step {{current}} of {{total}}.',
            dismiss: 'Dismiss',
            providerSummaryExternalBound: 'External provider bound',
            providerSummaryPickExternal: 'Pick an external provider',
            providerSummaryInherited: 'Inherited from runtime',
            providerSummarySaved: 'Saved provider',
            providerSummaryPickX: 'Pick {{provider}}',
            providerSummaryInlineKey: 'Inline API key',
            providerSummaryEnterKey: 'Enter an API key',
            runtimeShortExisting: 'Existing runtime',
            customProvider: 'Custom',
            managed: 'Managed',
            useNewApiKey: 'Use new API key',
            provideCredentials: 'Provide credentials for this agent',
            useOwnSubscription: 'Use your own subscription',
            subscriptionSignInHint:
                'Sign in on the computer or sandbox after creating',
            subscriptionSignInExplainer:
                'After the agent is created, open its terminal and sign in with the coding CLI using your own plan. The sign-in stays on the runtime.',
            subscriptionSignInPrivacy:
                'Manyfold stores no API key for this agent.',
            noSavedKeys: 'No saved keys yet. Add one in',
            addModelProvider: 'Add Model Provider',
            reuseAcrossAgents: 'to reuse it across agents.',
            saveApiKey: 'Save this API key',
            keyLabelPlaceholder: 'Label (e.g. personal)',
            leaveBlankOfficialEndpoint: 'Leave blank to use official endpoint:',
            modelConfigTestHint:
                'Test provider before selecting framework model settings.',
            testing: 'Testing…',
            testAndLoadModels: 'Test & load models',
            testProvider: 'Test provider',
            selectProviderFirst: 'Select a provider first.',
            providerTestFailed: 'Provider test failed.',
            apiKeyMinLength: 'API key must be at least 10 characters.',
            claudeModelMapping: 'Claude model mapping',
            selectProviderModel: 'Select provider model',
            defaultModel: 'Default model',
            selectModel: 'Select model',
            effort: 'Effort',
            codexModelSettings: 'Codex model settings',
            model: 'Model',
            chooseSupportedModel: 'Choose supported model',
            speed: 'Speed',
            reasoning: 'Reasoning',
            progress: {
                validating: 'Validating input',
                selectingAccount: 'Preparing capacity',
                insertingAgent: 'Reserving agent',
                creatingWorkspace: 'Creating workspace',
                configuringNetwork: 'Configuring network',
                bootstrappingFramework: 'Bootstrapping framework',
                installingFramework: 'Installing framework binaries',
                startingService: 'Starting framework service',
                checkingQuota: 'Checking quota',
                preparingWorkspace: 'Preparing workspace',
                securingCredentials: 'Securing credentials',
                creatingStorage: 'Creating storage',
                startingRuntime: 'Starting runtime',
                connectingRuntime: 'Connecting runtime',
                publishingRuntime: 'Publishing runtime',
                waitingForReadiness: 'Waiting for readiness',
                storingCredentials: 'Storing credentials',
                restoringBackup: 'Restoring backup',
                finalizing: 'Finalizing',
                createFailed: 'Create failed',
                failedAt: 'Failed at {{step}}'
            },
            externalProviderLabel: '{{provider}} provider',
            noExternalProviderConfigured:
                'No {{provider}} providers configured yet. Register one in Settings, then return here.',
            manageExternalProviders: 'Manage external providers →',
            externalProviderHint:
                'Provider holds the endpoint URL + API key. Manage at',
            externalAgentsSettings: 'Settings → External agents',
            change: 'Change',
            custom: 'Custom',
            default: 'Default',
            changeWorkspaceAria:
                'Change workspace directory, current {{kind}} {{path}}',
            notAvailable: 'Not available',
            limitReached: 'Limit reached',
            cloneFromProfile: 'Clone from profile',
            noProfilesFound: 'No profiles found in this runtime.',
            openMenu: 'Open menu',
            newAgent: 'New agent',
            backToWorkspace: '← Back to workspace',
            creatingAgent: 'Creating agent',
            name: 'Name',
            nameExample: 'e.g. bright-otter',
            generateRandomName: 'Generate random name',
            agentFramework: 'Agent framework',
            compareFrameworks: 'Compare frameworks',
            coming: 'Coming',
            agentRuntime: 'Agent runtime',
            compareRuntimes: 'Compare runtimes',
            providerModelsNotLoaded:
                'Provider models are not loaded yet. Load them to enable creating this agent.',
            addAgentToRuntime: 'Add agent to runtime',
            configureWorkspace: 'Configure workspace',
            workspaceDirectory: 'Workspace directory',
            workspaceHint:
                'Leave blank to use the default directory. Custom paths must already exist and be readable, writable, and enterable inside the selected runtime.',
            defaultWorkspace: 'Default workspace',
            useDefault: 'Use default',
            compareAgentRuntimes: 'Compare agent runtimes',
            compareRuntimesDesc:
                'Differences between Stateful sandbox, Cloud computer, and Self-owned computer.',
            statefulSandbox: 'Stateful sandbox',
            usageBased: 'Usage-based',
            alwaysOnlineRented: 'Always online · Rented',
            alwaysOnlineYourMachine: 'Always online · Your machine',
            cost: 'Cost',
            sandboxCost: 'Usage-based billing; sleeps automatically when idle.',
            persistentCost: 'Pays for reserved resource usage.',
            daemonCost:
                'Uses the connected user machine; no cloud runtime is provisioned.',
            response: 'Response',
            sandboxResponse:
                'May cold start, so responses can be slightly slower.',
            persistentResponse: 'Always online for fast responses.',
            daemonResponse:
                'Depends on the self-owned computer and host machine availability.',
            backgroundTasks: 'Background tasks',
            sandboxBackground:
                'Best for interactive tasks; not suitable for always-on background work after sleep.',
            persistentBackground:
                'Supports background tasks and long-running services.',
            daemonBackground:
                'Available while the daemon is running on the user machine.',
            deployableAgents: 'Deployable agents',
            deployableAgentsFull:
                'Claude Code, Codex, Gemini CLI, OpenClaw, Hermes Agent, NarraNexus',
            deployableAgentsShort:
                'Claude Code, Codex, Gemini CLI, OpenClaw, Hermes Agent',
            compareFrameworksDesc:
                'Primary use case, runtime support, and availability for each framework.',
            bestFor: 'Best for',
            externalBinding: 'External binding',
            available: 'Available',
            runtimeUsed: '{{used}} used',
            runs: 'runs',
            nameHint:
                '1–64 characters. You can use any language, emoji, spaces, _ - .',
            runtimeSelect: 'Select runtime',
            createRuntimeNamed: 'Create new {{runtime}}',
            selectedRuntime: 'Selected runtime',
            createRuntime: 'Create {{runtime}}',
            runtimeCategory: 'Runtime category',
            frameworkDescriptions: {
                claudeCode:
                    'Anthropic coding agent for repository work, terminal workflows, and long-running implementation sessions.',
                codex: 'OpenAI coding agent for codebase changes, reviews, and workspace-aware development tasks.',
                geminiCli:
                    'Google Gemini CLI for coding and general terminal automation inside a managed workspace.',
                narraNexus:
                    'Narrative-driven, hot-pluggable agent framework with a per-runtime workspace; chat and providers are managed in the NarraNexus native UI.',
                hermes: 'Persistent service agent for connectors, automations, and background workflows that need a long-running runtime.',
                openclaw:
                    'Framework runtime for tool-rich agent applications that need services, gateways, or scheduled jobs.',
                dify: 'External — bind a Dify app via /chat-messages SSE. No filesystem workspace; provider lives in Settings → External agents.',
                langflow:
                    'External — bind a Langflow flow via /api/v1/run/{flow}. No filesystem workspace; provider lives in Settings → External agents.',
                a2a: 'External — bind a saved A2A agent endpoint via the A2A protocol. No filesystem workspace; provider lives in Settings → External agents.'
            },
            remoteLangflowIdLabel: 'Langflow flow ID',
            remoteDifyIdLabel: 'Dify app ID',
            remoteLangflowPlaceholder: 'flow id (UUID) or endpoint name',
            remoteLangflowHint:
                'Found in your Langflow workspace under the flow page (or set "Endpoint Name" on the flow).',
            remoteDifyHint:
                'Found in your Dify app under "API Reference → App ID".',
            externalTag: 'ext',
            agentCountOne: '1 agent',
            agentCountMany: '{{count}} agents',
            apiKey: 'API key',
            anthropicAuthToken: 'Anthropic auth token',
            openAiApiKey: 'OpenAI API key',
            providerKeyHint: 'Use your provider-compatible key.',
            baseUrlProxyPlaceholder: 'Leave blank to use Netmind proxy default',
            customModel: 'Custom model',
            filterAll: 'All',
            providerSharedHint: 'Changing it replaces the stored credentials for every agent on this runtime.',
            providerChangeFailed: 'Agent {{name}} was created, but the provider change failed: {{reason}}',
            modelInheritHint: 'Leave blank to use the runtime\'s default model.',
            agentsColumn: 'Agents',
            sandboxNameHint: 'Rename it now or keep the generated name — you can rename it later.',
            pagination: 'Pagination',
            previousPage: 'Previous page',
            nextPage: 'Next page',
            kind: 'Kind',
            readyTag: 'Ready',
            modelProviderSection: 'Model provider'
        },
        externalProviderDialog: {
            title: 'Add {{provider}} provider',
            desc: 'This provider is saved and used for this agent.',
            nameLabel: 'Name',
            namePlaceholder: 'e.g. my-dify',
            endpointLabel: 'Endpoint URL',
            apiKeyLabel: 'API key',
            confirm: 'Save & use',
            checking: 'Checking…',
            verifyFailed:
                "Couldn't reach that provider. Check the endpoint and key.",
            addAnother: 'Add provider'
        },
        cliLogin: {
            titleLogin: 'Approve sign-in from your terminal',
            subtitleLogin:
                'A command you ran in a terminal (mf login or mf setup) wants to use your Manyfold account.',
            titleGrant: 'Approve agent permissions',
            subtitleGrant:
                'An agent you own is asking for permission to act on its own resources.',
            codeCheckHint:
                'Make sure this code matches the one shown in your terminal:',
            signedInAs: 'Signed in as',
            authorize: 'Authorize sign-in',
            authorizing: 'Authorizing…',
            redirecting: 'Returning to your terminal…',
            consequence:
                'This signs the terminal in as you, with access to your account.',
            safety: "Didn't run a command just now? Close this page. Nothing happens until you authorize.",
            authCodeTitle: 'One last step',
            authCodeHint:
                'Paste this code into your terminal to finish signing in:',
            expired:
                'This request has expired. Run the command in your terminal again to get a fresh link.',
            alreadyDone: 'This request was already completed in another tab.',
            grantDoneTitle: 'Authorization complete.',
            grantDoneHint:
                'You can close this window. The agent will continue once it picks up the new token.',
            missingRequest:
                'This link is missing its login request. Copy the full URL from your terminal.',
            loading: 'Loading request…',
            requestingAgent: 'Requesting agent',
            unknownAgent: 'an unknown agent (it may have been deleted)',
            grantNote:
                'These permissions apply only to this agent and its own resources, not to your other agents.',
            permissionsLabel: 'Permissions to grant',
            permissionsHint:
                'Pre-checked items are what the agent asked for. You can uncheck any, but you cannot add scopes it did not request.',
            approve: 'Approve',
            cancel: 'Cancel',
            selectScope: 'Select at least one scope to approve.',
            highRiskTitle: 'Grant high-risk scopes',
            highRiskBody1: 'You are about to grant high-risk scopes:',
            highRiskBody2:
                'These let this agent act on your resources. Continue?',
            highRiskConfirm: 'Grant'
        },
        connectA2a: {
            title: 'Connect agents to an application',
            subtitle:
                'An application is asking to connect to agents in your Manyfold account.',
            codeCheckHint:
                'Make sure this code matches the one shown in the application:',
            signedInAs: 'Signed in as',
            requesterLabel: 'Requesting application',
            unverifiedNote:
                'Name and URL are provided by the requester — Manyfold has not verified them.',
            consequence:
                'Approving lets this application send messages to the selected agents as you and read their task results.',
            safety: 'Only continue if you just started a connection from this application yourself. If someone sent you this link, close the page.',
            agentsLabel: 'Agents to connect',
            agentsHint:
                'The application receives one access token per selected agent.',
            noAgents: 'No agents in your account yet.',
            exposedBadge: 'A2A on',
            notExposedBadge: 'A2A off',
            enableExposureLabel: 'Enable A2A exposure for selected agents',
            enableExposureHint:
                'Some selected agents are not exposed yet — approving will open them for external A2A access.',
            exposureRequired:
                'Some selected agents are not exposed. Turn on "Enable A2A exposure" or deselect them.',
            selectAgent: 'Select at least one agent.',
            approve: 'Approve',
            approving: 'Approving…',
            deny: 'Deny',
            doneTitle: 'Authorized {{count}} agent(s).',
            doneHint:
                'You can return to {{clientName}} now — it picks up the connection automatically.',
            deniedTitle: 'Request denied.',
            deniedHint:
                'You can close this window. The application will see the request was denied.',
            expired:
                'This request has expired. Start the connection again from the application.',
            alreadyDone: 'This request was already completed.',
            missingRequest:
                'This link is missing its connection request. Copy the full URL from the application.',
            loading: 'Loading request…'
        },
        connectDaemon: {
            titleRegister: 'Connect a new computer',
            desc: "Run this in that computer's terminal. It installs the CLI, signs you in, and connects.",
            cmdInstallLabel: 'No mf CLI on that machine',
            cmdInstallNote: 'Installs the CLI, then connects. macOS and Linux.',
            cmdPlatform: 'macOS and Linux',
            cmdRegisterLabel: 'Already has mf',
            cmdRegisterNote: 'Works on any OS with mf installed.',
            windowsGuide: 'Windows guide',
            renameAria: 'Rename this computer',
            renameSave: 'Save name',
            step1: 'Name this computer',
            step2: "Copy one command, run it in that computer's terminal",
            step3: 'It connects here automatically, usually within seconds',
            back: 'Back',
            namePlaceholder: 'laptop / desktop / homelab',
            close: 'Close',
            tokenOnce: 'Both lines use the same token, shown once. Copy now.',
            copy: 'Copy',
            waiting: 'Waiting for the machine to connect…',
            online: 'online',
            offline: 'offline',
            connectedBanner: '{{name}} connected',
            detectedLabel: 'Detected coding agents',
            noneDetected: 'No coding agents detected yet',
            use: 'Use this machine',
            frameworkMissingTitle:
                "{{framework}} isn't installed on {{name}} yet",
            frameworkMissingHint:
                'Install {{framework}} on the machine — no need to re-register. The daemon picks it up on its next heartbeat.',
            learnHow: 'Learn how'
        },
        selfOwned: {
            breadcrumbRuntimes: 'Runtimes',
            title: 'Self-owned computers',
            connectedTitle: 'Connected machines',
            connectedEmpty: 'No machines connected yet. Connect one below.',
            connectNewTitle: 'Connect a new machine',
            tokensTitle: 'Tokens',
            tokensEmpty: 'No tokens issued.',
            issue: 'Issue token',
            revoke: 'Revoke',
            delete: 'Delete',
            createAgent: '+ Create agent →',
            machineMeta:
                'frameworks: {{frameworks}} · agents: {{agents}} · last seen {{lastSeen}}',
            cliVersion: 'cli {{version}}',
            upgradeBlockedTip:
                'Remote upgrade needs the daemon online, autostart-managed, and on a recent CLI. Update the CLI on the machine once to enable it.',
            upgradeAvailableSuffix: '{{version}} available',
            needsUpgradeTitle: 'CLI upgrade required',
            needsUpgradeHintPrefix:
                "This machine's mf CLI is below the required minimum version. Run",
            needsUpgradeHintThen: 'then',
            boundUnbound: 'unbound',
            tokenMeta: 'bound: {{bound}} · last used {{lastUsed}}',
            tokenRevokedMeta: ' · revoked {{revoked}}',
            revokeTokenTitle: 'Revoke daemon token',
            revokeTokenDesc: 'The bound daemon will stop working immediately.',
            revokeHostTitle: 'Revoke machine',
            revokeHostDesc:
                'Its agents will be marked stopped. Workspace data on the machine is kept.',
            deleteHostTitle: 'Delete machine',
            deleteHostDesc:
                'Permanently delete the {{name}} machine registration, its bound daemon tokens, and its agent and runtime records from Manyfold. Workspace data on the machine is kept. This cannot be undone.',
            msgTokenRevoked: 'Token revoked',
            msgMachineRevoked: 'Machine revoked',
            msgMachineDeleted: 'Machine deleted',
            msgCommandCopied: 'Command copied',
            startupLaunchdUser: 'autostart · login (launchd)',
            startupLaunchdSystem: 'autostart · boot (launchd)',
            startupSystemdUser: 'autostart · login (systemd)',
            startupSystemdSystem: 'autostart · boot (systemd)',
            startupManual: 'manual',
            startupUnknown: 'startup unknown'
        },
        agentNewV3: {
            managedProvider: 'Manyfold managed',
            welcomeTitle: 'Create an agent to get started',
            returningTitle: 'Create agent',
            frameworkLabel: 'Framework',
            creditLabel: 'Model provider',
            creditPlatformHint: 'No API key needed — granted to new users',
            creditGranting: 'Claiming your credits…',
            creditError: "Credits didn't arrive yet",
            creditRetry: 'Retry',
            creditBalance: 'Balance {{amount}}',
            creditGift: 'Gift {{amount}}',
            creditGiftPending: 'Claiming {{amount}} gift…',
            balanceEmptyNote:
                'You can create your agent now — your credits arrive shortly and chatting begins once they land.',
            preparingAccount: 'Preparing your account…',
            useOwnKey: 'Use your own API key',
            useNewKey: 'Use new API key',
            keySavedHint:
                'Saved to your model providers and used for this agent',
            keyDialogTitle: 'Add API key',
            keyDialogDesc:
                'This key is saved to your model providers and used for this agent.',
            keyDialogConfirm: 'Save & use',
            keyNameLabel: 'Name',
            keyNamePlaceholder: 'e.g. personal',
            keyChecking: 'Checking key…',
            keyRejected:
                'This key was rejected. Check the value and try again.',
            keyCheckBaseUrl:
                "Couldn't reach that endpoint. Check the base URL.",
            keyCheckTimeout: 'The check timed out. Try again.',
            keyCheckFailed:
                "Couldn't verify this key. Try again, or continue in advanced setup.",
            nameLabel: 'Name',
            nameHint:
                'Letters, numbers, emoji, spaces, underscore, dash and dot — up to {{max}} characters.',
            nameFixTo: 'Use "{{name}}"',
            randomize: 'New name',
            workspaceLabel: 'Workspace',
            workspaceHint:
                "The agent's working directory. {agent-id} is filled in automatically.",
            modelLabel: 'Model',
            modelProbing: 'Fetching models…',
            modelManualHint: "Couldn't load models — enter one manually.",
            summaryNote:
                'Model, name, and environment can be changed anytime after creation.',
            summarySandbox: 'Sandbox',
            summaryDefaultModel: 'default model',
            summaryPlatformCredits: 'platform credits',
            summaryOwnKey: 'your API key',
            createCta: 'Create agent',
            creating: 'Creating…',
            chooseFramework: 'Choose framework',
            modeQuick: 'Quick',
            modeAdvanced: 'Advanced',
            modeSwitchLabel: 'Create mode',
            runtimeCreateNewLabel: 'Create new',
            runtimeNewSandbox: 'New sandbox',
            runtimeQuotaLabel: 'Sandbox quota',
            runtimeUsageTooltip:
                '{{used}} of {{limit}} sandbox VMs provisioned',
            runtimeQuotaFullTag: 'Quota full',
            runtimeQuotaReached:
                'Your provisioned sandbox quota is full. Reuse a compatible sandbox below, or delete an unused sandbox.',
            runtimeManageSandboxes: 'Manage sandboxes',
            runtimeQuotaQuick:
                'Quick create needs a new sandbox, but your sandbox quota is full.',
            runtimeChooseExisting: 'Choose an existing sandbox',
            runtimeReuseLabel: 'Or reuse existing',
            runtimeReadyTag: 'Ready',
            runtimeInstallHint: 'Installs {{framework}}',
            runtimeServiceSlotTaken: 'Already runs {{framework}}',
            runtimeRefresh: 'Refresh',
            runtimeOfflineTag: 'Offline',
            runtimeOfflineHint:
                'This daemon is offline. Start it on your machine first.',
            runtimeMissingTag: '{{framework}} not detected',
            runtimeMissingHint:
                'Install {{framework}} on the machine, then refresh to select it.',
            runtimeIrreversible: "Runtime can't be changed after creation.",
            providerModelLabel: 'Provider & model',
            modelFamilyLabel: 'API protocol',
            providerCompatHint: 'Showing providers compatible with {{family}}',
            providerManagedUnavailable:
                "Platform credits don't cover {{family}}.",
            cardBasicsTitle: 'What kind of agent',
            cardRuntimeTitle: 'Where it runs',
            cardModelTitle: 'Which model it uses, and how it bills',
            cardConnectionTitle: 'Which app it connects to',
            cap: {
                general: 'General-purpose',
                code: 'Code',
                terminal: 'Terminal',
                fastIteration: 'Fast iteration',
                multimodal: 'Multimodal',
                assistant: 'Assistant',
                research: 'Research',
                lightweight: 'Lightweight',
                personalAssistant: 'Personal assistant',
                channels: 'Chat channels',
                calendarEmail: 'Calendar & email',
                multiAgent: 'Multi-agent',
                memory: 'Long-term memory',
                visualBuilder: 'Visual builder',
                connectApp: 'Connect an app',
                protocol: 'Protocol'
            }
        },
        apiTokens: {
            title: 'API tokens',
            createTitle: 'Create API token',
            namePlaceholder: 'OpenAI SDK / production worker',
            scopeLabel: 'Token scope',
            expiryLabel: 'Token expiry',
            scopeChat: 'Chat completions',
            scopeFull: 'Full account API',
            expiryNever: 'Never expires',
            expiryDays: '{{days}} days',
            create: 'Create token',
            copyDescription: 'Copy this token now. It will not be shown again.',
            copy: 'Copy',
            empty: 'No API tokens created.',
            revokeTitle: 'Revoke API token',
            revokeDescription:
                'Connected clients using this token will stop working immediately.',
            revoke: 'Revoke',
            copied: 'Token copied',
            statusRevoked: 'Revoked',
            statusExpired: 'Expired',
            statusActive: 'Active',
            created: 'Created',
            lastUsed: 'Last used',
            never: '—',
            expires: 'Expires',
            neverExpires: 'Never',
            revokedAt: 'Revoked',
            dashboardHeading: 'Dashboard',
            nameLabel: 'Name',
            issuedTitle: 'Token created',
            done: 'Done',
            colToken: 'Token',
            statusLabel: 'Status',
            emptyTitle: 'No API tokens yet',
            emptyBody: 'Create a token to call the API from your own code.',
            countActive: '{{count}} active',
            countExpired: '{{count}} expired',
            countRevoked: '{{count}} revoked',
            countNeverUsed: '{{count}} never used',
            createdVia: 'Created via',
            boundAgent: 'Bound agent',
            bindingEnforced: 'Enforced',
            tokenId: 'Token ID',
            scopesTitle: 'Scopes',
            scopesMultiple: 'Multiple scopes',
            scopesDescription: 'What this token is allowed to do.',
            usageTitle: 'Usage',
            usageNoHistory:
                'Only the time a token was last used is recorded, not individual requests, so there is no per-request log to show here.',
            usageLastSeen: 'Last request seen {{when}}.',
            usageNeverSeen: 'This token has not been used yet.'
        },
        buyContainer: {
            title: 'Buy a container',
            description:
                'Each container is a dedicated k8s pod with the framework runtime, sized to your selected SKU. Multiple agents can share one container.',
            purchased: 'Purchased {{name}}! Provisioning your container now.',
            purchaseDisabled:
                'Self-serve purchase is coming soon. Please contact an administrator to grant you this container.',
            noSkus: 'No SKUs are available right now. Please check back later.',
            region: 'Region',
            cpu: 'CPU',
            memory: 'Memory',
            disk: 'Disk',
            perMonth: '/month',
            submitting: 'Submitting…',
            buy: 'Buy'
        },
        cloudComputers: {
            title: 'Cloud computers',
            description:
                'Platform-rented always-online runtimes. Each cloud computer is a dedicated k8s pod that can host multiple agents.',
            empty: 'No cloud computers yet. Rent one to deploy always-online runtimes.',
            tag: 'Cloud computer',
            contains: 'contains {{count}} agents'
        },
        managedModelProvider: {
            title: 'Create managed key',
            description:
                'Create a provider key backed by the Manyfold managed account.',
            labelOptional: 'Label optional',
            labelPlaceholder: 'Managed OpenAI',
            disabled: 'Managed providers are not enabled for this account.',
            submit: 'Create managed key'
        },
        modelProviderFields: {
            inferenceProtocol: 'Inference protocol',
            providerName: 'Provider name',
            providerNamePlaceholder: 'e.g. personal',
            apiKey: 'API key',
            apiKeyKeepExisting: 'Leave blank to keep existing',
            apiKeyPlaceholder: 'sk-...',
            baseUrl: 'Base URL',
            baseUrlPlaceholder: 'https://api.example.com/v1',
            modelsListUrl: 'Models list URL (optional)',
            modelsListHint:
                'Override only if the provider does not expose models at the default path.',
            testing: 'Testing…',
            testConnection: 'Test connection',
            editTestHint:
                'Enter a new key + base URL to test, or use the row Test button below.',
            createTestHint:
                'Enter an API key (10+ chars) and a base URL to enable Test.'
        },
        providerTest: {
            testFailed: 'Test failed',
            testedOk: 'Tested OK',
            models: '{{count}} models',
            hideModels: 'Hide models',
            viewModels: 'View {{count}} models'
        },
        creditHistory: {
            title: 'Credit history',
            description:
                'Top-ups and redeemed codes applied to your managed inference credit.',
            managedCredit: 'Managed credit',
            balance: 'Balance {{value}}',
            balanceUnavailable: 'Balance unavailable',
            concurrency: 'Concurrency {{value}}',
            date: 'Date',
            source: 'Source',
            amount: 'Amount',
            status: 'Status',
            sourceTopUp: 'Top-up',
            sourceRedeem: 'Redeem',
            concurrencyUnit: 'concurrency',
            daysUnit: 'days',
            statusSucceeded: 'Succeeded',
            statusCompleted: 'Completed',
            statusPending: 'Pending',
            statusFailed: 'Failed',
            statusCanceled: 'Canceled',
            statusActive: 'Active',
            statusExpired: 'Expired',
            statusRedeemed: 'Redeemed'
        },
        sandboxNew: {
            title: 'New sandbox',
            tag: 'Stateful sandbox',
            subtitle:
                "Private stateful sandbox — fast to boot. Add coding agents after it's created.",
            nameLabel: 'Name (optional)',
            namePlaceholder: 'Leave blank to auto-name sandbox-NNN',
            nameHint:
                'Leave blank to auto-name (sandbox-001, sandbox-002, …) — rename anytime. 1-64 characters; any language, emoji, spaces, _ - .',
            creating: 'Creating sandbox…',
            create: 'Create sandbox'
        },
        externalAgentProviders: {
            title: 'External Agent Providers',
            description:
                'Register a Dify or Langflow endpoint, then bind agents to a specific Dify app or Langflow flow under it.',
            add: 'Add provider',
            allProviders: 'All providers',
            filterTooltip: 'Filter providers by type',
            filterAria: 'Provider filter',
            empty: 'No providers yet. Click “Add provider” to register one.',
            emptyFiltered:
                'No {{provider}} configured. Pick a different filter or add one.',
            lastTest: 'last test',
            editing: 'Editing',
            edit: 'Edit',
            testing: 'Testing…',
            test: 'Test',
            delete: 'Delete',
            deleteTitle: 'Delete provider',
            deleteDescription:
                'Agents using this external provider will fail to send until you configure another provider.',
            editTitle: 'Edit provider',
            editDescription: 'Update endpoint, label, or rotate the API key.',
            addDescription: 'Register a Dify app or Langflow flow endpoint.',
            testHint:
                'Enter a new API key to test, or save and use the per-row Test button.',
            testConnection: 'Test connection',
            saveChanges: 'Save changes',
            providerFixed:
                'Provider type is fixed once created. Delete and re-add if you need to switch.',
            label: 'Label',
            labelPlaceholder: 'production',
            endpoint: 'Endpoint URL',
            apiKey: 'API Key',
            apiKeyKeepExisting: 'Leave blank to keep existing key',
            keyLabel: 'key'
        },
        modelProviders: {
            saving: 'Saving…',
            savePrices: 'Save prices',
            resetAutomatic: 'Reset to automatic',
            pricingRecords: 'Pricing records',
            searchPricing: 'search both tables…',
            useAutomatic: 'Use automatic match',
            newProvider: 'New model provider',
            groupBy: {
                none: 'None',
                provider: 'Provider',
                protocol: 'Protocol',
                status: 'Status'
            },
            managed: 'Manyfold managed',
            emptyTitle: 'No model providers yet',
            emptyBody:
                'Add a built-in provider with your API key, or configure a custom endpoint.',
            noProviders: 'No providers yet.',
            customProvider: 'Custom provider',
            connectNetmind: 'Connect with NetMind account',
            netmindHint:
                'Sign in with your NetMind account and we create a Manyfold API key there for you — model usage bills your NetMind balance.',
            pasteApiKey: 'or paste an API key',
            name: 'Name',
            optionalNameHint:
                'Optional — name this key to tell instances apart (e.g. {{provider}} personal).',
            apiKey: 'API key',
            pasteKey: 'Paste your provider API key',
            saveProvider: 'Save provider',
            connectNetmindDescription:
                'Sign in with your NetMind account to configure it as a model provider.',
            providerKeysCount: '{{count}} provider keys',
            unavailable: 'Unavailable',
            managedBalance: 'Managed balance',
            topUp: 'Top up',
            usageSync: 'Usage sync',
            today: 'Today',
            noUsage: 'No usage',
            monthSpend: '30d spend',
            noData: 'No data',
            monthRequests: '30d requests',
            apiCalls: 'API calls',
            providerKeys: 'Provider keys',
            notYetUsed: 'Not yet used',
            deleteKeyTitle: 'Delete provider key',
            deleteKeyDescription: 'Existing agents are unaffected.',
            delete: 'Delete',
            hide: 'Hide',
            reveal: 'Reveal',
            deleteProvider: 'Delete provider',
            hideKey: 'Hide key',
            revealKey: 'Reveal key',
            createCustom: 'Create custom provider',
            createCustomDescription:
                "For providers not in the built-in catalog. You'll provide base URL and protocol manually.",
            neverTested: 'Never tested — click Refresh to discover models.',
            models: 'Models',
            refreshing: 'Refreshing…',
            refreshModels: 'Refresh models',
            enabledCount: '{{enabled}} of {{total}} enabled',
            default: 'default',
            enableAll: 'Enable all',
            disableAll: 'Disable all',
            noModels: 'No models.',
            priceInput: 'Input',
            priceOutput: 'Output',
            priceInputShort: 'in',
            priceOutputShort: 'out',
            pricePerToken: 'per token',
            priceCostPerTokenAria: '{{model}} {{label}} cost per token',
            priceCacheRead: 'Cache read',
            priceCacheWrite: 'Cache write',
            priceScopeCustom: 'custom',
            priceScopePlatform: 'platform',
            priceScopeNoPrice: 'no price',
            pricingSearchAria: 'Search pricing records for {{model}}',
            priceInUse: 'in use',
            priceUseThis: 'Use this',
            priceNoRecord:
                'Neither table has a record for this ID — enter a price above.',
            matchExact: 'Exact',
            matchFuzzy: 'Fuzzy',
            matchSearch: 'Search',
            modelsFraction: '{{enabled}}/{{total}} models',
            managedModelsSummary:
                '{{enabled}}/{{total}} models · {{protocols}} protocols',
            managedModelsSummarySingle:
                '{{enabled}}/{{total}} models · {{protocols}} protocol',
            usageUpdated: 'Usage updated {{time}}',
            accountSynced: 'Account synced {{time}}',
            requests: '{{count}} requests',
            tokens: '{{count}} tokens',
            allModels: 'All ({{count}})',
            searchModels: 'Search models',
            searchCount: '{{shown}} of {{total}}',
            newProviderButton: 'New model provider',
            lastTested: 'Last tested {{time}}',
            statusReady: 'Ready',
            statusMissing: 'Missing',
            statusError: 'Error'
        },
        runtimeDetail: {
            versionPending: 'version pending',
            status: {
                ready: 'Ready',
                pending: 'Pending',
                failed: 'Failed',
                stopped: 'Stopped',
                unknown: 'Unknown',
                online: 'Online',
                offline: 'Offline'
            },
            changeVersion: 'change version',
            updating: 'Updating…',
            endpoint: 'Endpoint',
            version: 'Version',
        },
        agentRuntimesList: {
            collapseHost: 'Collapse host',
            expandHost: 'Expand host',
            runtime: 'runtime',
            runtimes: 'runtimes',
            keepAliveOn:
                'Keep-alive is on — this runtime holds the whole sandbox awake.',
            update: 'Update',
            install: 'Install',
            command: 'Command',
            copied: 'Copied',
            copy: 'Copy',
            officialGuide: 'Official installation guide ↗',
            guideDescription:
                'Run this on {{host}}, then the daemon detects it automatically — Manyfold never installs CLIs on your own computer.',
            latest: 'latest',
            installedNotProvisioned: 'Installed · not provisioned',
            preinstalledReady: 'Pre-installed · ready to provision',
            notInstalled: 'Not installed',
            needsSandbox: 'Needs its own sandbox',
            notProvisioned: 'Not provisioned',
            noCliVersion:
                'No CLI version reported yet — upgrading installs one.',
            versionUnknown: 'Version unknown',
            changeCliVersion: 'Change mf CLI version',
            managedBy:
                'Managed by Manyfold — delete via the framework, not here.',
            managed: 'Managed',
            active: 'Active',
            keepAliveLease:
                'Keep-alive lease — managed by the runtime keep-alive toggle, not deletable here.',
            deleting: 'Deleting…',
            delete: 'Delete',
            remoteUpgradeHint:
                'Remote upgrade needs the daemon online, autostart-managed, and on a recent CLI. Update the CLI on the machine once to enable it.',
            noCliVersionShort: 'No CLI version reported yet.',
            stopSandbox: 'Stop sandbox',
            deleteSandbox: 'Delete sandbox',
            rename: 'Rename',
            stopping: 'Stopping…',
            removingRuntimes: 'Remove its runtimes first',
            stoppingSandbox: 'Stopping sandbox…',
            deletingSandbox: 'Deleting sandbox…',
            machineOffline: 'Machine offline',
            upgrading: 'Upgrading…',
            upgrade: 'Upgrade',
            runtimesTitle: 'Runtimes',
            availableFrameworks: 'Available frameworks',
            detecting: 'Detecting…',
            detectFrameworks: 'Detect frameworks',
            installDaemonHint:
                'Install agent CLIs on this machine yourself — the daemon detects them automatically.',
            provisionHint:
                'Provision another agent CLI on this sandbox. Service frameworks (openclaw/hermes) run as their own sprite.',
            activity: 'Activity',
            deleteService: 'Delete service',
            deleteTask: 'Delete task',
            controls: 'Controls',
            terminal: 'Terminal',
            terminalDescription:
                'Allow opening an interactive shell into this sandbox from the web.',
            terminalModelCredentials: 'Model credentials in the terminal',
            terminalModelCredentialsDescription:
                'Let a terminal session carry this agent\'s model credentials, so a coding CLI can resume a chat session in its own interface. Anyone who can open this terminal can then read the key.',
            details: 'Details',
            spriteId: 'Sprite ID',
            created: 'Created',
            hostname: 'Hostname',
            os: 'OS',
            startupMethod: 'Startup method',
            homeDir: 'Home dir',
            workspaceBase: 'Workspace base',
            lastSeen: 'Last seen',
            location: 'Location',
            renameHost: 'Rename host',
            newSandboxHost: 'New sandbox host',
            rentCloudComputer: 'Rent a cloud computer',
            connectComputer: 'Connect a self-owned computer',
            configureExternal: 'Configure external agent service',
            newRuntime: 'New runtime',
            runtimesAria: 'Runtimes',
            collapseAll: 'Collapse all',
            expandAll: 'Expand all',
            statusNone: 'None',
            statusKind: 'Kind',
            statusStatus: 'Status',
            statusFramework: 'Framework',
            stable: 'Stable',
            staging: 'Dev',
            hostActions: 'Host actions',
            stop: 'Stop',
            stopDescription:
                'Stop sandbox "{{name}}"? Agents on it are stopped and keep-alive turned off — they wake automatically on the next message. Other services are stopped and activity tasks removed so the sandbox can suspend.',
            deleteSandboxDescription:
                'Delete sandbox "{{name}}"? The sprite VM and its data will be destroyed.',
            agent: 'agent',
            agents: 'agents',
            serviceRunning: 'Running',
            serviceStarting: 'Starting',
            serviceStopping: 'Stopping',
            serviceStopped: 'Stopped',
            serviceFailed: 'Failed',
            sandbox: 'Sandbox',
            cluster: 'Cluster',
            available: 'available',
            provision: 'Provision',
            alreadyRuns: '{{framework}} already runs here',
            unavailableAction: 'unavailable',
            leaseExpires: 'keep-alive lease expires {{time}}',
            guideInstallMethods:
                'Any install method works — the daemon finds the CLI on your PATH (including Homebrew, a native installer, or nvm/fnm/volta) and registers it as a runtime.',
            versionPickerDaemon:
                'Pick a version to install on "{{name}}". The daemon restarts and agents on this machine stop briefly.',
            versionPickerSandbox:
                'Pick a version to install on "{{name}}". The upgrade is in-place; nothing restarts.',
            latestVersion: 'Latest (v{{version}})',
            cliAvailable: 'mf CLI v{{version}} is available',
            machineCliDetail:
                'This machine runs {{version}}. Upgrading restarts the daemon briefly.',
            sandboxCliDetail:
                'This sandbox runs {{version}}. The upgrade is in-place; nothing restarts.',
            activePeriod: 'active {{duration}} this period',
            activityDescription:
                'What keeps this sandbox awake: managed services (e.g. a dev server) and activity leases — the keep-alive toggle installs one. Keep-alive leases are managed from the runtime toggle; agent-registered tasks can be deleted here.',
            loading: 'Loading…',
            loadingActivity: 'Loading activity…',
            services: 'Services',
            tasks: 'Tasks',
            deleteServiceDescription:
                'Delete service "{{name}}"? It will be stopped and removed from the sprite.',
            deleteTaskDescription:
                'Delete task "{{name}}"? Its activity lease is released; the sandbox can then suspend when idle.',
            cliLabel: 'mf CLI',
            sandboxCliDescription:
                'Platform CLI installed in this sandbox. Upgrades are in-place; nothing restarts.',
            daemonCliDescription:
                'Daemon CLI on this machine. Upgrading restarts the daemon briefly.',
            noMatches: 'No matches.',
            newRuntimeButton: 'New runtime',
            upgradeMessage:
                'Upgrading mf CLI to {{version}} — daemon restarting…',
            alreadyOnVersion: 'Already on {{version}}',
            upgradedMessage: 'mf CLI upgraded to v{{version}}'
        },
        runtimesDashboard: {
            heading: 'Dashboard',
            viewGrid: 'Grid view',
            viewList: 'List view',
            newSandbox: 'New sandbox',
            rentComputer: 'Rent computer',
            connectMachine: 'Connect machine',
            addProvider: 'Add provider',
            usageDetails: 'Usage details',
            storage: 'Storage',
            activeThisPeriod: 'Active this period',
            agents: 'Agents',
            colName: 'Name',
            colLastTest: 'Last test',
            testPassed: 'Test passed',
            testFailed: 'Test failed',
            neverTested: 'Never tested',
            noSandboxes: 'No sandboxes yet.',
            noMachines: 'No self-owned computers connected yet.',
            noClusters: 'No cloud computers yet.',
            noProviders: 'No external providers yet.'
        },
        modelProvidersDashboard: {
            heading: 'Dashboard',
            spend: 'Spend',
            tokens: 'Tokens',
            requests: 'Requests',
            lastUsed: 'Last used',
            total: 'Total',
            windowAll: 'All time',
            colProvider: 'Provider',
            unattributed: 'Unattributed',
            unattributedHint:
                'Turns whose agent had no model provider bound, or whose provider has since been deleted.',
            unpriced: '{{count}} unpriced',
            unpricedHint:
                'Some turns have no recorded cost, so this is a lower bound on the real spend.'
        },
        channelNew: {
            title: 'New {{provider}} channel',
            noAgentsTitle: 'No agents yet',
            noAgentsBody:
                'A channel routes messages to an agent, so create an agent first.'
        },
        channelsDashboard: {
            heading: 'Dashboard',
            colChannel: 'Channel',
            messagesWindow: 'Messages ({{days}}d)',
            messagesWindowHint:
                'Delivery history is kept for {{days}} days, so this counts the last {{days}} days only.',
            inOut: '{{inbound}} in · {{outbound}} out',
            lastMessage: 'Last message',
            noMessages: 'No messages yet'
        },
    },
    admin: {
        nav: {
            dashboard: 'Dashboard',
            primaryNavigation: 'Admin navigation',
            expandSidebar: 'Expand sidebar',
            collapseSidebar: 'Collapse sidebar',
            openSidebar: 'Open navigation',
            closeSidebar: 'Close navigation',
            expandGroup: 'Expand {{group}}',
            collapseGroup: 'Collapse {{group}}',
            operations: 'Operations',
            infrastructure: 'Infrastructure',
            usersBilling: 'Users & billing',
            catalogs: 'Catalogs',
            platformSettings: 'Platform settings',
            agentManagement: 'Agent management',
            accounts: 'Accounts',
            frameworks: 'Frameworks',
            skills: 'Skills',
            mcp: 'MCP',
            sandboxCapacity: 'Sandbox capacity',
            turnPolicies: 'Turn policies',
            dataRetention: 'Data retention',
            rollouts: 'Rollouts',
            agents: 'Agents',
            agentRuntimes: 'Agent Runtimes',
            sandboxes: 'Sandboxes',
            channels: 'Channels',
            modelProviders: 'Model providers',
            clusters: 'Cloud computer clusters',
            spritesAccounts: 'Stateful sandbox accounts',
            selfOwnedComputers: 'Self-owned computers',
            users: 'Users',
            loginProvider: 'Login provider',
            emailProvider: 'Email provider',
            notificationWebhooks: 'Notification webhooks',
        },
        dashboard: {
            title: 'Dashboard',
            welcome: 'Welcome back',
        },
        agents: {
            title: 'Agents',
            empty: 'No agents yet. Create your first one to get started.',
            primaryTooltip:
                "This is the runtime's primary agent — remove it via Delete Runtime on the runtime page.",
            filters: {
                framework: 'Framework',
                runtime: 'Runtime',
                status: 'Status',
                all: 'All',
                clear: 'Clear filters'
            },
            cols: {
                name: 'Name',
                framework: 'Framework',
                model: 'Model',
                cluster: 'Cluster',
                runtime: 'Runtime',
                status: 'Status',
                createdAt: 'Created',
                owner: 'Owner'
            },
            status: {
                pending: 'Pending',
                running: 'Running',
                stopped: 'Stopped',
                failed: 'Failed'
            },
            new: {
                title: 'New Agent',
                subtitle:
                    'Provision an agent and bootstrap its framework on a Stateful sandbox or Cloud computer.',
                nameLabel: 'Name',
                namePlaceholder: 'my-agent',
                nameHint:
                    '1-64 characters. You can use any language, emoji, spaces, _ - .',
                frameworkLabel: 'Framework',
                frameworkClaudeCode: 'Claude Code',
                frameworkCodex: 'Codex',
                frameworkGeminiCli: 'Gemini CLI',
                frameworkOpenclaw: 'OpenClaw',
                frameworkHermes: 'Hermes',
                frameworkDify: 'Dify',
                frameworkLangflow: 'Langflow',
                externalProviderLabel: 'External provider',
                externalProviderEmpty:
                    'No external agent providers are registered for this owner.',
                externalProviderEmptyHint:
                    "Configure one from the owner's Manyfold workspace.",
                difyAppIdLabel: 'Dify app ID',
                langflowFlowIdLabel: 'Langflow flow ID',
                runtimeLabel: 'Runtime',
                runtimeSprites: 'Stateful sandbox (default)',
                runtimeK8s: 'Cloud computer',
                runtimeHint:
                    'Where the agent runs. Claude Code, Codex, Gemini CLI, OpenClaw, Hermes, and NarraNexus support Stateful sandbox; use Cloud computer for always-on containers.',
                clusterLabel: 'Cloud computer cluster',
                clusterHint:
                    'Pick the registered cluster where this agent will be provisioned.',
                clusterEmpty:
                    'No Cloud computer clusters registered yet. An admin must add one before you can create a Cloud computer agent.',
                clusterEmptyCta: 'Register a cluster',
                accountLabel: 'Stateful sandbox account',
                accountHint:
                    'Pin a specific Stateful sandbox account for this agent. Leave to auto-pick the least-loaded enabled one.',
                accountEmpty:
                    'No enabled Stateful sandbox accounts. Register one before creating a Stateful sandbox agent.',
                accountEmptyCta: 'Register a Stateful sandbox account',
                ownerLabel: 'Owner (admin only)',
                ownerHint:
                    'Create the agent on behalf of another user. Only admins can pick a different owner.',
                ownerSelf: 'Myself',
                claudeCodeTokenLabel: 'Anthropic Auth Token',
                claudeCodeTokenHint:
                    'Your ANTHROPIC_AUTH_TOKEN. Stored encrypted.',
                claudeCodeBaseUrlLabel: 'Anthropic Base URL (optional)',
                codexKeyLabel: 'OpenAI API Key',
                codexKeyHint: 'Your OPENAI_API_KEY. Stored encrypted.',
                codexBaseUrlLabel: 'OpenAI Base URL (optional)',
                openclawProviderLabel: 'Model Provider',
                openclawProviderAnthropic: 'Anthropic',
                openclawProviderOpenai: 'OpenAI',
                openclawProviderOpenrouter: 'OpenRouter',
                openclawApiKeyLabel: 'API Key',
                openclawApiKeyHint:
                    'API key for the selected provider. Stored encrypted.',
                openclawModelNameLabel: 'Model Name',
                openclawModelNameHint:
                    'Model id for the selected provider (e.g. gpt-4o-mini, claude-3.5-sonnet, anthropic/claude-3.5-sonnet).',
                openclawBaseUrlLabel: 'Base URL (optional)',
                hermesPrimaryModelSection: 'Primary model',
                hermesPrimaryProviderLabel: 'Provider',
                hermesPrimaryProviderOpenrouter: 'OpenRouter',
                hermesPrimaryProviderAnthropic: 'Anthropic',
                hermesPrimaryProviderOpenai: 'OpenAI',
                hermesPrimaryApiKeyLabel: 'API Key',
                hermesPrimaryApiKeyHint:
                    'API key for the primary model provider. Stored encrypted.',
                hermesPrimaryModelNameLabel: 'Model Name (optional)',
                hermesPrimaryModelNameHint:
                    'Leave blank to use the provider default. Hermes requires a model with \u226564k context window.',
                hermesPrimaryBaseUrlLabel: 'Base URL (optional)',
                hermesPlatformsSection: 'Platforms',
                hermesPlatformsHint:
                    'Pick at least one platform. Enable a checkbox to reveal its credentials.',
                hermesPlatformTelegram: 'Telegram',
                hermesPlatformDiscord: 'Discord',
                hermesPlatformSlack: 'Slack',
                hermesPlatformWhatsapp: 'WhatsApp',
                hermesPlatformSignal: 'Signal',
                hermesPlatformMatrix: 'Matrix',
                hermesPlatformEmail: 'Email',
                hermesPlatformHomeAssistant: 'Home Assistant',
                hermesTokenLabel: 'Token',
                hermesMatrixHomeserverLabel: 'Homeserver URL',
                hermesMatrixAccessTokenLabel: 'Access Token',
                hermesEmailHostLabel: 'SMTP Host',
                hermesEmailPortLabel: 'SMTP Port',
                hermesEmailUserLabel: 'SMTP User',
                hermesEmailPasswordLabel: 'SMTP Password',
                hermesProfileLabel: 'Profile (optional)',
                hermesProfileHint:
                    '1-64 chars. Used to differentiate Hermes deployments for the same user.',
                submit: 'Create Agent',
                submitDisabledHint:
                    'Fill required fields and pick at least one Hermes platform to enable submit.',
                back: 'Back to Agents',
                step: {
                    validating: 'Validating input',
                    selecting_account: 'Selecting sandbox account',
                    inserting_agent: 'Reserving agent record',
                    creating_sprite: 'Creating Stateful sandbox',
                    applying_network_policy: 'Applying network policy',
                    bootstrapping: 'Installing framework credentials',
                    checking_quota: 'Checking agent quota',
                    preparing_namespace: 'Preparing namespace',
                    creating_secret: 'Creating secret',
                    creating_storage: 'Creating storage volume',
                    creating_deployment: 'Starting Cloud computer',
                    creating_service: 'Connecting Cloud computer',
                    creating_ingress: 'Publishing Cloud computer',
                    waiting_for_ready: 'Waiting for agent to be ready',
                    storing_credentials: 'Storing encrypted credentials',
                    finalizing: 'Finalizing'
                },
                progress: {
                    title: 'Provisioning agent',
                    failed: 'Agent creation failed at this step.',
                    retry: 'Retry',
                    resumedTitle: 'Provisioning in progress',
                    resumedBody:
                        'This agent is still being provisioned. Refresh in a moment.'
                }
            },
            detail: {
                title: 'Agent Detail',
                notFound: 'Agent not found.',
                owner: 'owner',
                primaryPill: 'Primary',
                primaryDeleteButton: 'Delete runtime',
                lastReconciledAt: 'lastReconciledAt',
                internalId: 'internalId',
                model: 'model',
                frameworkInternals: {
                    title: 'Framework Internals',
                    empty: 'No framework-specific metadata yet.',
                    collapse: 'Collapse',
                    expand: 'Expand'
                },
                tabs: {
                    overview: 'Overview',
                    files: 'Files'
                },
                delete: {
                    button: 'Delete',
                    confirm:
                        'Delete this agent? This also removes its Stateful sandbox / Cloud computer resources and files. This cannot be undone.',
                    deleting: 'Deleting…',
                    error: 'Delete failed'
                },
                sessions: {
                    title: 'Chat sessions',
                    subtitle:
                        'Most recent conversations with this agent, newest activity first.',
                    empty: 'No chat sessions yet.',
                    loading: 'Loading…',
                    viewAll: 'View all →',
                    cols: {
                        session: 'Session',
                        user: 'User',
                        status: 'Status',
                        lastTurn: 'Last turn',
                        messages: 'Msgs',
                        tokens: 'Tokens',
                        cost: 'Cost',
                        lastActivity: 'Last activity'
                    }
                },
                files: {
                    title: 'Files',
                    unavailable:
                        'File browser is available once the agent is running.',
                    loading: 'Preparing file browser…',
                    refresh: 'Refresh',
                    newFolder: 'New folder',
                    newFolderHere: 'New folder here',
                    newFolderPrompt: 'New folder name',
                    upload: 'Upload',
                    uploadHere: 'Upload here',
                    rename: 'Rename',
                    renamePrompt: 'Rename to',
                    nameSlash: 'Name cannot contain /',
                    delete: 'Delete',
                    deleteConfirm: 'Delete {{name}}? This cannot be undone.',
                    download: 'Download',
                    copyPath: 'Copy path',
                    copyRelativePath: 'Copy relative path',
                    copyFilename: 'Copy filename',
                    empty: 'This root is empty.',
                    selectFile: 'Select a file to preview or edit.',
                    readOnly: 'read-only',
                    loadFailed: 'Failed to load {{name}}',
                    loadingDir: 'Loading {{name}}…',
                    retry: 'Retry',
                    dismiss: 'dismiss'
                }
            }
        },
        clusters: {
            title: 'Cloud computer clusters',
            subtitle:
                'Register one or more clusters that back Cloud computer agents. Cloud computer agents will be provisioned into the cluster you pick at creation time.',
            newButton: 'Add Cluster',
            empty: 'No clusters registered yet.',
            cols: {
                name: 'Name',
                description: 'Description',
                health: 'Health',
                updatedAt: 'Updated'
            },
            health: {
                ok: 'Reachable',
                failed: 'Unreachable',
                unknown: 'Not checked'
            },
            actions: {
                edit: 'Edit',
                probe: 'Test connection',
                delete: 'Delete',
                deleteConfirm:
                    'Delete this cluster? Agents referencing it will have their cluster link cleared.'
            },
            form: {
                titleCreate: 'Add Cloud computer cluster',
                titleEdit: 'Edit Cloud computer cluster',
                nameLabel: 'Name',
                namePlaceholder: 'eu-west-prod',
                nameHint: '1-64 chars. Used in dropdowns when creating agents.',
                descriptionLabel: 'Description (optional)',
                descriptionHint: 'Free-form note shown in the list.',
                hostSuffixLabel: 'Ingress host suffix (optional)',
                hostSuffixHint:
                    'If set, agents get `<agentId>.<suffix>` as their ingress host. Leave blank to use the platform default.',
                kubeconfigLabel: 'Cluster config (YAML)',
                kubeconfigHint:
                    'Paste the full cluster config. Stored encrypted (AES-256-GCM). A connectivity probe runs on save.',
                kubeconfigHintEdit:
                    'Paste a new cluster config to replace the stored one, or leave blank to keep the current one.',
                submitCreate: 'Add Cluster',
                submitUpdate: 'Save Changes',
                submitting: 'Saving…',
            }
        },
        spritesAccounts: {
            title: 'Stateful sandbox accounts',
            subtitle:
                'Register API tokens used to provision Stateful sandbox agents. Tokens are stored encrypted and can be rotated or disabled without downtime.',
            newButton: 'Add Account',
            empty: 'No Stateful sandbox accounts registered yet.',
            cols: {
                slug: 'Slug',
                org: 'Org',
                status: 'Status',
                activeSprites: 'Active',
                notes: 'Notes',
                updatedAt: 'Updated'
            },
            status: {
                enabled: 'Enabled',
                disabled: 'Disabled'
            },
            actions: {
                edit: 'Edit',
                rotate: 'Rotate token',
                disable: 'Disable',
                enable: 'Enable',
                disableConfirm:
                    'Disable this account? Running agents keep working; new agents cannot pick it until re-enabled.'
            },
            form: {
                titleCreate: 'Add Stateful sandbox account',
                titleEdit: 'Edit Stateful sandbox account',
                slugLabel: 'Slug',
                slugPlaceholder: 'prod-eu',
                slugHint:
                    '1-64 chars. Lowercase letters, digits, underscore, dash. Used in dropdowns when creating agents.',
                tokenLabel: 'Stateful sandbox token',
                tokenHint:
                    'Paste the full token string: "<orgSlug>/<orgId>/<tokenId>/<tokenValue>". Stored encrypted (AES-256-GCM).',
                tokenPlaceholder: 'netmind/org_xxx/tok_xxx/sk_xxx',
                notesLabel: 'Notes (optional)',
                notesHint: 'Free-form note shown in the list.',
                rotateTitle: 'Rotate token',
                rotateHint:
                    'Paste a new token to replace the stored one. The slug stays the same; running agents keep their already-decrypted token.',
                rotateLabel: 'New Stateful sandbox token',
                submitCreate: 'Add Account',
                submitUpdate: 'Save Changes',
                submitRotate: 'Rotate Token',
                submitting: 'Saving…',
                rotateSuccess: 'Token rotated.',
            }
        },
        users: {
            title: 'Users',
            subtitle:
                'All users who have signed into the platform. Toggle admin role to grant or revoke access to admin-only operations.',
            empty: 'No users have signed in yet.',
            cols: {
                email: 'Email',
                role: 'Role',
                joinedAt: 'Joined'
            },
            roles: {
                user: 'User',
                admin: 'Admin'
            },
            actions: {
                promote: 'Make admin',
                demote: 'Revoke admin',
                selfHint: 'You cannot revoke your own admin role.'
            },
            deletion: {
                title: 'Danger zone',
                description:
                    'Deletion deactivates the account immediately and permanently deletes it after the grace period. A pending deletion can still be restored.',
                none: 'No deletion has been requested for this account.',
                reasonLabel: 'Reason',
                reasonPlaceholder: 'Optional reason recorded with the request',
                rows: {
                    status: 'Status',
                    requestedAt: 'Requested',
                    scheduledAt: 'Scheduled for',
                    executedAt: 'Executed',
                    restoredAt: 'Restored',
                    reason: 'Reason',
                    lastError: 'Last error'
                },
                status: {
                    awaiting_confirmation: 'Awaiting confirmation',
                    pending: 'Pending deletion',
                    restored: 'Restored',
                    executed: 'Executed',
                    expired: 'Request expired'
                },
                actions: {
                    request: 'Request deletion',
                    requestConfirm:
                        'Request deletion for {{email}}? The account is deactivated immediately and permanently deleted after the grace period.',
                    restore: 'Restore',
                    restoreConfirm:
                        'Cancel the pending deletion and reactivate {{email}}?',
                    execute: 'Execute now',
                    executeConfirm:
                        'Skip the grace period and delete {{email}} now?',
                    executeConfirmFinal:
                        'This permanently deletes the account and all of its data. It cannot be undone. Continue?'
                }
            }
        },
        agentRuntimes: {
            title: 'Agent Runtimes',
            subtitle:
                'Each runtime is a Stateful sandbox or Cloud computer pinned to one framework. Multiple agents can live inside a runtime, sharing its boot environment and credentials.',
            empty: 'No agent runtimes yet. They are created automatically when you provision an agent.',
            viewLink: 'View runtime →',
            newButton: 'New Runtime',
            cols: {
                name: 'Name',
                owner: 'Owner',
                framework: 'Framework',
                kind: 'Kind',
                status: 'Status',
                agents: 'Agents',
                keepAlive: 'Keep-alive',
                location: 'Location',
                createdAt: 'Created'
            },
            status: {
                pending: 'Pending',
                ready: 'Ready',
                failed: 'Failed',
                stopped: 'Stopped'
            },
            kind: {
                sprites: 'Stateful sandbox',
                k8s: 'Cloud computer'
            },
            actions: {
                delete: 'Delete',
                deleteConfirm:
                    'Delete this runtime? Its agents, credentials, and runtime resources will all be torn down.',
                keepAliveEnable: 'Enable',
                keepAliveDisable: 'Disable',
                keepAliveSaving: 'saving…'
            },
            detail: {
                notFound: 'Runtime not found.',
                actions: {
                    addAgent: 'Add agent',
                    addAgentUnsupported:
                        'Adding agents is not supported for this framework/runtime combination.',
                    delete: 'Delete runtime'
                },
                info: {
                    primaryAgentId: 'primaryAgentId',
                    spriteName: 'Stateful sandbox name',
                    namespace: 'namespace',
                    ingressHost: 'ingressHost',
                    mountPath: 'mountPath',
                    accountSlug: 'Stateful sandbox account',
                    clusterName: 'cluster',
                    createdAt: 'createdAt',
                    lastBootstrappedAt: 'lastBootstrappedAt',
                    serviceStatus: 'serviceStatus',
                    currentPhase: 'currentPhase',
                    failureReason: 'failureReason'
                },
                agentsSection: {
                    title: 'Agents in this runtime',
                    empty: 'No agents yet — add one to get started.',
                    remove: 'Remove',
                    removeConfirm:
                        'Remove this agent from the runtime? The framework CLI will delete it inside the runtime.',
                    removing: 'Removing…',
                    cols: {
                        internalId: 'Internal ID',
                        name: 'Name',
                        model: 'Model',
                        workspace: 'Project path',
                        status: 'Status',
                        lastReconciledAt: 'Last synced',
                    }
                },
                addAgent: {
                    title: 'Add agent to runtime',
                    cancel: 'Cancel',
                    nameLabel: 'Name',
                    namePlaceholder: 'Display name (e.g. Writer, 研究助手 🚀)',
                    workspaceLabel: 'Workspace path (optional)',
                    workspacePlaceholder: '/workspace/<name>',
                    modelLabel: 'Model (optional)',
                    modelPlaceholder: 'gpt-4o-mini',
                    cloneFromLabel: 'Clone from (optional)',
                    cloneFromNone: '— none —',
                    submit: 'Add agent',
                    submitting: 'Adding…'
                }
            }
        }
    }
}

export default en
