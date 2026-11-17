-- LIVE ONLY. One-time fix, NOT a migration: it is not in meta/_journal.json.
-- Run it once on the live project (Supabase dashboard → the live project →
-- SQL Editor → New query → paste this whole file → Run), BEFORE the first
-- merge that the migrate-live job (.github/workflows/migrate-live.yml) handles.
-- Running it on dev, or a second time on live, changes nothing.
--
-- WHY. Drizzle records each migration file it runs in
-- drizzle.__drizzle_migrations, and decides what to run next from the LAST row
-- there alone: every file whose journal `when` is later runs. Live's log stops
-- at 0033 (34 rows), because 0034–0106 were pasted into the SQL Editor by hand
-- and pasting writes no log row. If the job ran `drizzle-kit migrate` on live
-- as it is, Drizzle would try to run 0034–0106 again on real data. This marks
-- those 73 files as done, which they are.
--
-- WHAT IT WRITES. The 73 rows are copied from dev's log, which Drizzle itself
-- wrote on 2026-11-17 from the same files (hash + created_at; created_at is
-- each file's `when` in meta/_journal.json). Afterwards live's log holds
-- 0000–0106, row for row the same as dev's. Drizzle never reads the hash back.
--
-- SAFETY. The first block refuses — before anything is written — unless:
-- - 0106 really is applied here (the WhatsApp schedule reads the Vault
--   project_url — 0106's change). The log must never claim a file the
--   database does not have;
-- - and the log is either live's known state (exactly 34 rows, ending at
--   0033) or already holds 0034–0106 (backfilled before, or dev). Anything
--   else stops it.
-- The insert skips every row that is already there, so a second run adds
-- nothing. The last block checks the result.
--
-- After running it: tell Claude, who checks live's log read-only.

do $$
declare
  v_rows int;
  v_last bigint;
begin
  if not exists (select 1 from cron.job where command like '%project_url%') then
    raise exception 'backfill refused: 0106 is not applied on this database (its WhatsApp schedule does not read the Vault project_url). Nothing was changed.';
  end if;

  select count(*), max(created_at) into v_rows, v_last from drizzle.__drizzle_migrations;

  if v_rows = 34 and v_last = 1783870018810 then
    null; -- live as it was on 2026-11-17: 0000–0033 logged
  elsif (
    select count(*) from drizzle.__drizzle_migrations
    where created_at > 1783870018810 and created_at <= 1793307600000
  ) = 73 then
    null; -- 0034–0106 already logged (run before, or this is dev): the insert adds nothing
  else
    raise exception 'backfill refused: unexpected migration log (% rows, last %). Nothing was changed. Stop and ask Claude.', v_rows, v_last;
  end if;
end;
$$;

insert into drizzle.__drizzle_migrations (hash, created_at)
select v.hash, v.created_at
from (values
  ('ae14dbb689a6af14a7364f6c33ce42cf617986109fcb01c759f7724c39399781', 1787143297000),
  ('4d40f7e4209a33d8ba2071789f8384aaec219c483cf85887d628f6bc795040c0', 1787252845082),
  ('b8ac036349ac64006f79c80d11ec87b9b52ad53e02444dcca55ffaf65e2aef59', 1788835200000),
  ('0907b9ecf1674e23f3acd283ce8548abe528941bd9b4803f0b3ec0d6f83d06bd', 1788940800000),
  ('89ab0849d41e5fabb51e24f51c8da68cfae6457a24835273c07e448c57efc97e', 1789171200000),
  ('0242245d65d7ebd1137aad79150148d853bb25389e2921bebd1c3c9ff7f100c8', 1789174800000),
  ('5d9917a45d1fc3e0ebdcea7a24f21f49eaa5f752ee6022335708264c294d5908', 1789261200000),
  ('7a35e30feb8765e379b44b04b4b632d9b0a6a49dc72d835a46e8bff26dbe6bba', 1789264800000),
  ('190b9e0d20bf1dc7aebe830252bc468353ad78d7eb6bdeebdd7c5d90f2f89740', 1789268400000),
  ('17a47431e4695cf7d04bdc1047dc83940d74d53d5eb5712347a2d91c9b52a7ed', 1789272000000),
  ('c5773016c8bdd568c8b7a88f51ede07a1880d5f8e355106a7254e20994903423', 1789275600000),
  ('505614da169b5be8111dffbe9426b68399a06ec4b070f39e95da0dfb02621b1f', 1789279200000),
  ('5bff15e4cda8502eeec30d528f3f76fa5b4d44ea90e2f851ebb5de74923eea00', 1789282800000),
  ('6faed6733fc6469233339f9c1dfc6ae779125239f27531a02c22d565ea566a93', 1789286400000),
  ('44373408fcb0d750ddf4a2d71616723a51d8598b6676ec41414e783a29a77411', 1789290000000),
  ('ced5336dbb96959ccd950036c9be7eb10dffa54697e9b0e08020e49b32267d75', 1789293600000),
  ('44547c38c80d80d4bb46e866b19d1598e24410dfb61e22143192a25987f20a4f', 1789297200000),
  ('5cee40725cc889ac48e1b5e09786af6cf17bbce3bdd4f53c56a22185d20b2ca0', 1789300800000),
  ('af0106f2175b102ab0de1de4025292c8e294d025c656e10f5087354e95e0d7f2', 1789304400000),
  ('996ae8558e3ed8ec5b5400cb7312e1daf298fff0760b07ea0b005ba326d84191', 1789308000000),
  ('a413152a09fcdfce56d89cb8594d9021ecc003331c166579e4aed4693a1a6607', 1789311600000),
  ('0b7cf78b2ff652a0ab12e3616d6f9201ac2c590e542495ef1e3ac0d565c7a137', 1789315200000),
  ('8cc3e381691295cba4e2cf3fa7454ed5001a2dcd85fef2f59e6d6453a2729add', 1789318800000),
  ('bedb16cff7848a84534eb7c989da8dc801479f3e07cad8d0a32583657ae25912', 1789322400000),
  ('77f36f51669411115ab26702567b6c4fc6f4e0f815c49cf7393fa6d1c60e60cc', 1789326000000),
  ('92bbbe232c2957a0756cfb26915b798cc8d7e03131ce1e69867707f18273cba0', 1789329600000),
  ('55688ad7925a9fdd5c094a3028c15c60f69e1957f3a43ef0c39544354d310a2d', 1789333200000),
  ('8fb8664433b453731ea86b280d215594ca1bc69d89b339f9e65ba5b8b5f2443b', 1789419600000),
  ('15f9b30aa0f9264de8496746a3037957a0b7743180bb3a664dc94c780c369f97', 1789506000000),
  ('ba8f3b5e4aa547bb0cbf4e5ead33bf725a5902953531a9206a3a207e31cb01a3', 1789592400000),
  ('49733bfb300fc148ca5c0dbe37fd661c5b36987384e1be741ddbdcec1ab83f08', 1789678800000),
  ('126c21ae75e11eb8d9f98563f3dd70605264e8966763dd273e39c68e0a02eb3d', 1789765200000),
  ('192135dddcb07700b5cb7aeb042e7a45bb9dfe2d692ad0bc29f3eb1f2233d78e', 1789851600000),
  ('241a7104eed4f34bd91dfeb063279d936ab3f6a479230e622021413dea6cec6d', 1789938000000),
  ('54dfafa9a2394e9b973eb6269aea1638e82f9d0549cbe43a1597fa12d8c85310', 1790024400000),
  ('287fc614335dc00d0afbe2f6be5d993e7080120d54fd6663ff0aff53695d9b78', 1790110800000),
  ('a105c1105937985469deed95f2dadbbe0342c6fd38a6ea9bb5572e78ca3773af', 1790197200000),
  ('d5ae7fb7b7b3e533a39840b3e2fd1dd5b2353cb674cef1d5c5a95b7c1100dfa0', 1790283600000),
  ('05d53b6740e9df4540e75a15cd5d171bb56b097b38a16b1b6473fef91679643c', 1790370000000),
  ('905c20b7144f36e4aba123ad3fc96b8997aaa8f58c33c9a0d769e0b6f5bc7ade', 1790456400000),
  ('b30fb5d63a84ee336f597e62f31f091e43fdfc4fb145bca8edbda72000e0e7a6', 1790542800000),
  ('b1359a53fd047294ca22a97386bf25c1509888c85782d4769ba05e78d2df3f5c', 1790629200000),
  ('f430b88cc19a3d27ca8f37e7d6ad778f7c0c990939227830d5dfb05d7a4d845f', 1790715600000),
  ('c5a4d100178edc80734dc2c4fd9d9761a6e6dd89e0cd5af690a23b0d89be8d94', 1790802000000),
  ('cbec690ffd2ace5e8c257d4b9485a93f31a5591ced496eb13abc4632541b08ac', 1790888400000),
  ('f0b88acf541ac3e56ed8efa8112310bcb530c683db2e47f3c2dbdbb1f3b1783b', 1790974800000),
  ('3e4859f32d6a7399b2b19e1b5575a8831bf3e87e717bf09399734d207646df6b', 1791061200000),
  ('f0a74d15c7ad5faf2dd111cabe66d8bd867e04f081cd0fb2a2f38d83a4a69e4d', 1791147600000),
  ('ff6169d8fe4664e75d4fdf292437ded57ff7a5ee4e119635186d21b365f24c40', 1791234000000),
  ('2e3c0319882af4cb8a4d75c0f770874063d695d9e1944c26463ccd8386c772b3', 1791320400000),
  ('7af2f455d1cab37fa65dea25a892edc9aab7ed60ef35df0f713a12f7686b8a92', 1791406800000),
  ('2cfd73208e131e3469017c2cc22fc5e53f234fd19ecd8c6dee221818aa3fa751', 1791493200000),
  ('0f0cd5a108527c8900b70e58f3f8e914f1af59fe8d42395bce6cdf742090c666', 1791579600000),
  ('77a552caac7df86120d2b252e82ef94b5232d3037f5e22a754e70195dc1d934f', 1791666000000),
  ('25ba30eb9f4ac95df0f1dee3559efbfaa1478c9ee4fd33231587aad5becf6ffe', 1791752400000),
  ('1e0824381a0df2e4658a34fb0d4614d60c6d7900fd5b6896e5735b1b00834f06', 1791838800000),
  ('8df9024121d65df363975b7ab939233f1081db36db84d9c23c93805d8ab351a3', 1791925200000),
  ('f3bc36aa1795ffcfd1f2ee77cc779436e3ea26e60297319b11e47af54e6ae09e', 1792011600000),
  ('83c3676fcb7516596f44dcee4de850c5273807d40967e1d2d770ae9a3ec35c07', 1792098000000),
  ('cd000ea4cb2124f6062d57878ded88b2938be17373804d9b6aa45cd83684fcbb', 1792184400000),
  ('8d0a3984e6743278fe7267abf5744711753f2995d1b161b408f04e7a107080eb', 1792270800000),
  ('6230524e11669f80179f6134735022163fad65a37a9026558b94b210f79d2105', 1792357200000),
  ('1b98e124b5308ac078d5144e3c49b445b3ba9bfc13156887b7b5b13969639eac', 1792443600000),
  ('2774aedf62fff119f5eb6d708ec1617a7296b721a7d99c6c1f4676dcb3836fc2', 1792530000000),
  ('0cd84ebc7996c4a079266ed102a413cca3b535e77c397015a83f20db90b677a0', 1792616400000),
  ('cab7d69cecdb72cb53f8c7ca06999388ea7cd0d2f15a56f382b21870c797c2b2', 1792702800000),
  ('af440a9ab99543567b0caa9dbd6774a40abe9500db755ade3df00d2c47c442c7', 1792789200000),
  ('2f3d55b3d3d887a83733a5a11b9805debdd06823b01ada81dad0c35e7c929146', 1792875600000),
  ('6b1d56d7a92e3d6d93b70500d6833d3b6dcb8a96afa492f557bbdd1113dba739', 1792962000000),
  ('4575374ef6e67463f6c47c7b5382b38dd6b02e039f37971bae083b20e9e343dd', 1793048400000),
  ('6b19001c42777b01f40f2147dd6746471ed981fb4b8a845d7f5fdd85da65ab56', 1793134800000),
  ('3a7f053986a08250886f47a9e7e77ab09de41405441906e32258f019a2cff16b', 1793221200000),
  ('f7b31fa142e3c0c4031259c3ce816c3e1f37d49a17009292d9f36f6aef108a64', 1793307600000)
) as v(hash, created_at)
where not exists (
  select 1 from drizzle.__drizzle_migrations m where m.created_at = v.created_at
)
order by v.created_at;

do $$
begin
  if (
    select count(*) from drizzle.__drizzle_migrations
    where created_at > 1783870018810 and created_at <= 1793307600000
  ) <> 73 then
    raise exception 'backfill: the log does not hold 0034–0106 after the insert. Stop and ask Claude.';
  end if;
end;
$$;
