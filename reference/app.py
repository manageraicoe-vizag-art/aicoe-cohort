"""The live app (Week 3 version): visitors bring their own OpenAI API key.

    streamlit run app.py
"""
import json
from pathlib import Path

import streamlit as st
from openai import AuthenticationError, OpenAI

import rag

st.set_page_config(page_title="[Your app name]")
st.title("[Your app name]")
st.caption("Answers come only from [describe your documents]. Check anything important at the source.")

EXAMPLES = ["[Example question 1]", "[Example question 2]", "[Example question 3]"]
DEMO = json.loads(Path("demo_answers.json").read_text(encoding="utf-8")) if Path("demo_answers.json").exists() else {}
MAX_QUESTIONS = 20

# ---- the visitor's key: kept only in this browser session's memory, never saved, logged or printed
with st.sidebar:
    st.subheader("Your OpenAI API key")
    key = st.text_input("API key", type="password", placeholder="sk-...", label_visibility="collapsed")
    st.caption("Used only for your questions in this session, sent only to OpenAI, never stored. "
               "Use a key with a low spending limit and delete it when you're done. "
               "[Check your usage](https://platform.openai.com/usage)")
    if key and st.session_state.get("checked_key") != key:
        try:
            OpenAI(api_key=key).models.list()  # one cheap call to check the key
            st.session_state.checked_key = key
        except AuthenticationError:
            st.error("That key was not accepted. Check it and try again.")
            key = ""
        except Exception:
            st.error("Couldn't reach OpenAI to check the key. Try again in a moment.")
            key = ""
    if key:
        st.success("Key accepted for this session.")

if "history" not in st.session_state:
    st.session_state.history = []
for role, text in st.session_state.history:
    st.chat_message(role).markdown(text)


def show(text, sources):
    with st.chat_message("assistant"):
        st.markdown(text)
        if sources:
            with st.expander("Sources"):
                for n, h in enumerate(sources, 1):
                    link = f" ([open]({h['source_url']}))" if h.get("source_url") else ""
                    st.markdown(f"**[{n}] {rag.label(h)}**{link}")
                    st.caption(h["text"][:300] + "...")


if not key:
    st.info("Add your OpenAI API key in the sidebar to ask your own questions. Without one, try a saved example:")
    for q in DEMO:
        if st.button(q):
            st.chat_message("user").markdown(q)
            show(DEMO[q]["text"], DEMO[q]["sources"])
    st.stop()

if len(st.session_state.history) >= MAX_QUESTIONS * 2:
    st.info("Question limit for this session reached. Refresh the page to start again.")
    st.stop()

question = st.chat_input("Ask a question", max_chars=500)
if question:
    st.chat_message("user").markdown(question)
    with st.spinner("Searching the documents..."):
        try:
            res = rag.answer(question, api_key=key)
        except AuthenticationError:
            st.error("Your key stopped working (revoked or out of credit).")
            st.stop()
        except Exception:
            st.error("Something went wrong talking to OpenAI. Try again.")
            st.stop()
    show(res["text"], res["sources"])
    st.session_state.history += [("user", question), ("assistant", res["text"])]
