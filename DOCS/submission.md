# Submission: MiniMax Week × GMI Cloud

Campaign window: Aug 24 to Sep 6, 2026. Rules recap: core generation on MiniMax models served through GMI Cloud (supporting infrastructure from anywhere); a public repo; a demo video of at most 3 minutes; the description form; a post on X tagging MiniMax and GMI Cloud.

## Form fields

**Project name:** Interdimensional Cable

**Track:** Synthesis. The track's own phrase is "agents that direct": MiniMax-M3 directs the whole production (research, script, casting, per-line acting direction, lyrics) and Speech 2.8 HD and Music 3.0 execute it. The alternative would be Multimodality (sound as one produced output, a show that scores itself); Synthesis matches the product's identity and the site's own badge.

**MiniMax models used:** M3, Speech 2.8, Music 3.0. (Not H3: the video path is implemented but no submitted episode used it. Not M2.7.)

**Team:** Solo.

**Public repository:** https://github.com/arjunlohan/minimax-week-interdimensional-cable

**Live site:** https://minimax-week-interdimensional-cable.vercel.app

**Demo video:** at most 3:00 (the form's hard limit); host it on X or YouTube and paste the link.

**Full description:**

Interdimensional Cable turns any topic into a late-night talk show episode with no human in the loop. Pick a format (a four-host venture panel, a two-host podcast, a desk show), type a topic or paste a link, choose audio, a length from one to five minutes, and how much you already know. About twenty minutes later there is a finished episode on a public page: a theme song, hosts arguing in their own voices, and end credits that sing the episode's best jokes back to you. Then you can ask a host anything, in character, and it answers, out loud if you want.

Three MiniMax models do the work, all served through GMI Cloud on one key.

MiniMax-M3 is the showrunner. It researches the topic from fetched sources, runs a three-pass writers' room (research brief, head writer, then a voice pass that tightens every line to the seconds it actually has), writes the acting direction and emotion tag for each line, writes the theme lyrics and the credits song, answers listener questions in character grounded in the same research, and keeps a memory bank so the next episode adapts to the listener. Long-context inputs, JSON output validated against schemas with one repair round.

Speech 2.8 HD performs every line, one request per line, in a fixed voice per host with the emotion the script asks for, thirty to sixty lines an episode. The transcript is re-timed from the measured audio so it follows playback exactly.

Music 3.0 records the theme hook and the sung end-credits recap for every episode, from lyrics M3 wrote for that episode.

Everything runs as a durable Vercel workflow: research, script, voices, score, assembly with ffmpeg, publish to Mux. Each step is checkpointed and named on screen while it runs. Because one voice line can wait minutes in the model queue, the deployed site queues shows for a small render worker instead of pretending a 300-second function can finish them, and the progress page says so honestly.

What is original: the show scores itself and sings its own credits; the hosts remember you; and every episode ships with a receipt panel that says which model did what.

Try it: https://minimax-week-interdimensional-cable.vercel.app (Browse plays finished episodes; Create renders when the worker is online). Example episodes: a four-minute All In Like show about Steve Jobs' investment in Pixar, created on the live site, https://minimax-week-interdimensional-cable.vercel.app/watch/2752c892-9b8d-418c-9e29-207d8a11106c; and a five-minute one on the same topic, https://minimax-week-interdimensional-cable.vercel.app/watch/d25aeb36-6722-4b09-ac24-1ba743836ff5. Code: https://github.com/arjunlohan/minimax-week-interdimensional-cable.

MiniMax-H3 support (reference-to-video anchored to the host portrait and to each line's audio, with a spend guard) is implemented but not used in the submitted episodes. This is a rebuild, during the campaign window, of an earlier project of mine; the previous engines were replaced by MiniMax models, and the README's provenance section says what was kept.

## X post

Under 280 characters with the URL counted at 23. MiniMax's account shows as both @MiniMax_AI and @MiniMax__AI in search results; open the profile and use the one that posted most recently before sending.

```text
I built a late-night show that writes, voices, scores and sings itself. Type a topic, get an episode. MiniMax-M3, Speech 2.8 HD and Music 3.0 on one @gmi_cloud key, made for MiniMax Week with @MiniMax_AI. Try it: https://minimax-week-interdimensional-cable.vercel.app
```

```text
Four AI hosts just argued about Steve Jobs buying Pixar for four minutes. Nobody wrote it, voiced it or scored it. MiniMax-M3, Speech 2.8 HD and Music 3.0 on @gmi_cloud, built for MiniMax Week with @MiniMax_AI. Open source: https://github.com/arjunlohan/minimax-week-interdimensional-cable
```

## Checklist

- [x] Repo public, README placeholders filled
- [ ] Demo video at most 3:00, uploaded, link in the form
- [x] `DOCS/spend-ledger.md` matches `gmi_spend` ($0.00)
- [ ] Description form submitted with the text above
- [ ] X post published, tagging @gmi_cloud and MiniMax
