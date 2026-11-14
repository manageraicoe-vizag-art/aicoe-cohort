"""Week 2 version of the app: uses your team's key from .env. Week 3 replaces it."""
import streamlit as st

import rag

st.set_page_config(page_title="[Your app name]")
st.title("[Your app name]")
st.caption("Answers come only from [describe your documents]. Check anything important at the source.")
st.markdown("Try: *[Example question 1]* · *[Example question 2]* · *[Example question 3]*")

if "history" not in st.session_state:
    st.session_state.history = []
for role, text in st.session_state.history:
    st.chat_message(role).markdown(text)

question = st.chat_input("Ask a question", max_chars=500)
if question:
    st.chat_message("user").markdown(question)
    with st.spinner("Searching the documents..."):
        res = rag.answer(question)
    with st.chat_message("assistant"):
        st.markdown(res["text"])
        if res["sources"]:
            with st.expander("Sources"):
                for n, h in enumerate(res["sources"], 1):
                    link = f" ([open]({h['source_url']}))" if h.get("source_url") else ""
                    st.markdown(f"**[{n}] {rag.label(h)}**{link}")
                    st.caption(h["text"][:300] + "...")
        st.caption(f"{res['seconds']:.1f}s · about ${res['cost_usd']:.4f}")
    st.session_state.history += [("user", question), ("assistant", res["text"])]
