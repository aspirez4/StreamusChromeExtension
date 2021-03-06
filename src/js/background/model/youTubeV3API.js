﻿define(function(require) {
  'use strict';

  var Songs = require('background/collection/songs');
  var YouTubeAPIKey = require('background/key/youTubeAPIKey');
  var SongType = require('background/enum/songType');
  var YouTubeServiceType = require('background/enum/youTubeServiceType');
  var Utility = require('common/utility');

  var YouTubeV3API = Backbone.Model.extend({
    // Performs a search and then grabs the first item and returns its title
    // Expects options: { title: string, success: function, error: function }
    getSongByTitle: function(options) {
      return this.search({
        text: options.title,
        // Expect to find a playable song within the first 10 -- don't need the default 50 items
        maxResults: 10,
        success: function(searchResponse) {
          if (searchResponse.songs.length === 0) {
            if (options.error) {
              options.error(chrome.i18n.getMessage('failedToFindSong'));
            }
          } else {
            options.success(searchResponse.songs.first());
          }
        },
        error: options.error,
        complete: options.complete
      });
    },

    // Performs a search of YouTube with the provided text and returns a list of playable songs (<= max-results)
    // Expects options: { maxResults: integer, text: string, fields: string, success: function, error: function }
    search: function(options) {
      var activeJqXHR = this._doRequest(YouTubeServiceType.Search, {
        success: function(response) {
          var songIds = _.map(response.items, function(item) {
            return item.id.videoId;
          });

          activeJqXHR = this.getSongs({
            songIds: songIds,
            success: function(songs) {
              activeJqXHR = null;

              options.success({
                songs: songs,
                nextPageToken: response.nextPageToken,
              });
            },
            error: options.error,
            complete: options.complete
          });
        }.bind(this),
        error: function(error) {
          if (options.error) {
            options.error(error);
          }
          if (options.complete) {
            options.complete();
          }
        }
      }, {
        part: 'id',
        type: 'video',
        maxResults: options.maxResults || 50,
        pageToken: options.pageToken || '',
        q: options.text.trim(),
        fields: 'nextPageToken, items/id/videoId',
        // I don't think it's a good idea to filter out results based on safeSearch for music.
        safeSearch: 'none',
        videoEmbeddable: 'true'
      });

      return {
        promise: activeJqXHR,
        abort: function() {
          if (!_.isNull(activeJqXHR)) {
            activeJqXHR.abort();
          }
        }
      };
    },

    getChannelUploadsPlaylistId: function(options) {
      var listOptions = _.extend({
        part: 'contentDetails',
        fields: 'items/contentDetails/relatedPlaylists/uploads'
      }, _.pick(options, ['id', 'forUsername']));

      return this._doRequest('channels', {
        success: function(response) {
          if (_.isUndefined(response.items[0])) {
            options.error();
            throw new Error('No response.items found for options:' + JSON.stringify(options));
          }

          options.success({
            uploadsPlaylistId: response.items[0].contentDetails.relatedPlaylists.uploads
          });
        },
        error: options.error,
        complete: options.complete
      }, listOptions);
    },

    getSong: function(options) {
      return this.getSongs({
        songIds: [options.songId],
        success: function(songs) {
          if (songs.length === 0) {
            options.error(chrome.i18n.getMessage('failedToFindSong') + ' ' + options.songId);
          } else {
            options.success(songs.first());
          }
        },
        error: options.error,
        complete: options.complete
      });
    },

    // Returns the results of a request for a segment of a channel, playlist, or other dataSource.
    getPlaylistSongs: function(options) {
      var activeJqXHR = this._doRequest(YouTubeServiceType.PlaylistItems, {
        success: function(response) {
          var songIds = _.map(response.items, function(item) {
            return item.contentDetails.videoId;
          });

          activeJqXHR = this.getSongs({
            songIds: songIds,
            success: function(songs) {
              activeJqXHR = null;

              options.success({
                songs: songs,
                nextPageToken: response.nextPageToken,
              });
            },
            error: options.error,
            complete: options.complete
          });
        }.bind(this),
        error: function(error) {
          if (options.error) {
            options.error(error);
          }
          if (options.complete) {
            options.complete();
          }
        }
      }, {
        part: 'contentDetails',
        maxResults: 50,
        playlistId: options.playlistId,
        pageToken: options.pageToken || '',
        fields: 'nextPageToken, items/contentDetails/videoId'
      });

      return {
        promise: activeJqXHR,
        abort: function() {
          if (!_.isNull(activeJqXHR)) {
            activeJqXHR.abort();
          }
        }
      };
    },

    getRelatedSongs: function(options) {
      var activeJqXHR = this._doRequest(YouTubeServiceType.Search, {
        success: function(response) {
          // It is possible to receive no response if a song was removed from YouTube but is still known to StreamusBG.
          if (!response) {
            throw new Error('No response for: ' + JSON.stringify(options));
          }

          var songIds = _.map(response.items, function(item) {
            return item.id.videoId;
          });

          activeJqXHR = this.getSongs({
            songIds: songIds,
            success: function(songs) {
              activeJqXHR = null;
              options.success(songs);
            },
            error: options.error,
            complete: options.complete
          });
        }.bind(this),
        error: function(error) {
          if (options.error) {
            options.error(error);
          }
          if (options.complete) {
            options.complete();
          }
        }
      }, {
        part: 'id',
        relatedToVideoId: options.songId,
        maxResults: options.maxResults || 5,
        // If the relatedToVideoId parameter has been supplied, type must be video.
        type: 'video',
        fields: 'items/id/videoId',
        videoEmbeddable: 'true'
      });

      return {
        promise: activeJqXHR,
        abort: function() {
          if (!_.isNull(activeJqXHR)) {
            activeJqXHR.abort();
          }
        }
      };
    },

    // Converts a list of YouTube song ids into actual video information by querying YouTube with the list of ids.
    getSongs: function(options) {
      return this._doRequest(YouTubeServiceType.Videos, {
        success: function(response) {
          if (_.isUndefined(response)) {
            if (options.error) {
              options.error();
            }
            throw new Error('No response found for options: ' + JSON.stringify(options));
          }

          if (_.isUndefined(response.items)) {
            if (options.error) {
              var isSingleSong = options.songIds.length === 1;
              var errorMessage = chrome.i18n.getMessage(isSingleSong ? 'failedToFindSong' : 'failedToFindSongs');
              options.error(errorMessage);
            }
          } else {
            var playableItems = _.filter(response.items, function(item) {
              // Filter out songs are not able to be embedded since they are unable to be played in StreamusBG.
              var isEmbeddable = item.status.embeddable;

              // Songs with 0s duration are unable to be played and YouTube's API
              // sometimes responds (incorrectly) with PT0S.
              // https://code.google.com/p/gdata-issues/issues/detail?id=7172
              var hasValidDuration = item.contentDetails.duration !== 'PT0S';

              return isEmbeddable && hasValidDuration;
            });

            var songs = this._itemListToSongs(playableItems);
            options.success(songs);
          }
        }.bind(this),
        error: options.error,
        complete: options.complete
      }, {
        part: 'contentDetails, snippet, status',
        id: options.songIds.join(','),
        fields: 'items/id, items/contentDetails/duration, items/snippet/title, items/snippet/channelTitle, items/status/embeddable'
      });
    },

    getTitle: function(options) {
      var ajaxDataOptions = _.extend({
        part: 'snippet',
        fields: 'items/snippet/title'
      }, _.pick(options, ['id', 'forUsername']));

      return this._doRequest(options.serviceType, {
        success: function(response) {
          if (response.items.length === 0) {
            options.error(chrome.i18n.getMessage('errorLoadingTitle'));
          } else {
            options.success(response.items[0].snippet.title);
          }
        },
        error: options.error,
        complete: options.complete
      }, ajaxDataOptions);
    },

    insertPlaylist: function(options) {
      return this._doInsertRequest(YouTubeServiceType.Playlists, options.authToken, {
        success: options.success,
        error: options.error,
        complete: options.complete
      }, {
        snippet: {
          title: options.playlistTitle
        }
      });
    },

    insertPlaylistItems: function(options) {
      if (options.songIds.length > 0) {
        var songId = options.songIds.shift();

        return this._doInsertRequest(YouTubeServiceType.PlaylistItems, options.authToken, {
          // TODO: Tricky to report songs which failed to insert.
          complete: this.insertPlaylistItems.bind(this, options)
        }, {
          snippet: {
            playlistId: options.playlistId,
            resourceId: {
              kind: 'youtube#video',
              videoId: songId
            }
          }
        });
      } else {
        console.log('complete');
        if (options.success) {
          options.success();
        }

        if (options.complete) {
          options.complete();
        }
      }
    },

    _doInsertRequest: function(serviceType, authToken, ajaxOptions, ajaxDataOptions) {
      return $.ajax(_.extend({
        type: 'POST',
        url: 'https://www.googleapis.com/youtube/v3/' + serviceType + '?part=snippet',
        beforeSend: function(request) {
          request.setRequestHeader('Authorization', 'Bearer ' + authToken);
        },
        contentType: 'application/json; charset=utf-8',
        data: JSON.stringify(_.extend({
          key: YouTubeAPIKey
        }, ajaxDataOptions)),
      }, ajaxOptions));
    },

    _doRequest: function(serviceType, ajaxOptions, ajaxDataOptions) {
      return $.ajax(_.extend({
        url: 'https://www.googleapis.com/youtube/v3/' + serviceType,
        data: _.extend({
          key: YouTubeAPIKey
        }, ajaxDataOptions)
      }, ajaxOptions));
    },

    _itemListToSongs: function(itemList) {
      return new Songs(_.map(itemList, function(item) {
        return {
          id: item.id,
          duration: Utility.iso8061DurationToSeconds(item.contentDetails.duration),
          title: item.snippet.title,
          author: item.snippet.channelTitle,
          type: SongType.YouTube
        };
      }));
    }
  });

  return new YouTubeV3API();
});