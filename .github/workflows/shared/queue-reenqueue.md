---
import-schema:
  monitored-workflow:
    type: string
    required: true
  monitored-workflow-path:
    type: string
    required: true
safe-outputs:
  jobs:
    queue-reenqueue:
      description: Re-enqueue the approved PR named by the failed merge-queue branch as a fresh queue attempt.
      runs-on: ubuntu-slim
      permissions:
        contents: read
        pull-requests: write
      env:
        GH_AW_APP_BOT_SLUG: ${{ vars.GH_AW_APP_BOT_SLUG }}
      inputs:
        reason:
          description: Brief evidence of a clearly transient infrastructure failure.
          required: true
          type: string
      output: Fresh merge-queue attempt validated and requested.
      max: 1
      steps:
        - name: Checkout trusted queue handler
          uses: actions/checkout@v7
          with:
            ref: ${{ github.event.repository.default_branch }}
            token: ${{ github.token }}
            persist-credentials: false
            sparse-checkout: .github/workflows/shared
        - name: Generate App token
          id: app-token
          uses: actions/create-github-app-token@v3.2.0
          with:
            client-id: ${{ vars.GH_AW_APP_CLIENT_ID }}
            private-key: ${{ secrets.GH_AW_APP_PRIVATE_KEY }}
            permission-contents: read
            permission-actions: read
            permission-pull-requests: write
            permission-merge-queues: write
        - name: Validate and re-enqueue target
          uses: actions/github-script@v9
          with:
            github-token: ${{ steps.app-token.outputs.token }}
            script: |
              const queueReenqueue = require(`${process.env.GITHUB_WORKSPACE}/.github/workflows/shared/queue-reenqueue.cjs`);
              await queueReenqueue({
                core,
                context,
                github,
                monitoredWorkflow: '${{ github.aw.import-inputs.monitored-workflow }}',
                monitoredWorkflowPath: '${{ github.aw.import-inputs.monitored-workflow-path }}',
                process,
              });
---
