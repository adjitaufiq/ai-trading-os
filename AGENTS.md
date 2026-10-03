<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Frontend is a read-only view; strategy, guards and execution live in the external Python/FastAPI service. Why: architecture boundary (Evidence ≠ Decision, AI ≠ Authority).
- No order/execution code exists in the frontend until Stage 10 (DEMO). Why: capability must not exist, not merely be disabled.
- Market data enters via a MarketAdapter interface (mock now, API-backed later). Why: swap broker source without touching UI.
