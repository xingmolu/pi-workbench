# Code renderer notices

License text copied unchanged from the installed release packages:

- Shiki 4.4.3: MIT, `shiki-LICENSE.txt`; https://github.com/shikijs/shiki
- @pierre/diffs 1.4.2: Apache-2.0, `pierre-diffs-LICENSE.txt`; https://github.com/pierrecomputer/pierre

These files are included by the existing `resources/**` packaging rule. They document the new direct code-renderer dependencies, not an exhaustive inventory of every existing/transitive dependency. The application uses adapters around their public APIs; it does not modify their package source.
